import { createHash, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { FileClientsStore } from "./client-store.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAT_VERIFY_TTL_MS = 5 * 60 * 1000; // whoami re-check cadence for connection tokens
// A minted ist_ token leaves the local issued-token map after this long; from then on
// verifyAccessToken introspects it via /v1/whoami (which also sees revocation).
const ISSUED_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Scope vocabulary of the Inistate Connections API (ApiScopes.cs). Advertised as
 * scopes_supported in the authorization-server metadata and granted to the
 * connection token minted at code exchange. Must stay in sync with the backend.
 */
export const SUPPORTED_SCOPES: string[] = [
  "data.entries:read",
  "data.entries:write",
  "data.files:read",
  "data.files:write",
  "schema.modules:read",
  "schema.modules:write",
  "webhooks:manage",
  "user:read",
];

/** Matches ApiConnectionTokens.LooksLikeToken — "ist_" + 43 base62 chars. */
export function isConnectionToken(value: string | undefined): boolean {
  return !!value && /^ist_[0-9A-Za-z]{43}$/.test(value);
}

/**
 * The backend explicitly refused to mint a connection for this user — a policy
 * answer (pricing gate, connection limit), not an availability problem. Must
 * surface to the connecting user as an OAuth error, never silently downgrade
 * to a JWT session: that would let e.g. Lite-seat users bypass the pricing gate.
 */
export class ConnectionMintDeniedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectionMintDeniedError";
    this.code = code;
  }
}

/**
 * The mint could not be completed and the backend did NOT say the feature is off:
 * a 5xx, an unexpected status, an unusable body, or no answer at all.
 *
 * SS06119: this used to fall back to a login-JWT session. That is the one credential
 * the seat gate cannot price - McpSeatAuthorizeAttribute observes and never denies,
 * ruled 2026-09-05 so that sessions which already existed keep working - so any hiccup
 * on the mint handed a brand-new connector exactly the ungated session the gate exists
 * to refuse. The exchange now fails and the connector retries. The fallback survives
 * only for the explicit "Connections is off" answer (404), which is what it was for.
 */
export class ConnectionMintUnavailableError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ConnectionMintUnavailableError";
    this.status = status;
  }
}

/**
 * 400/403 from the connections API are policy answers (pricing gate, limits,
 * invalid scopes) whose message belongs in front of the connecting user.
 * Anything else returns normally so the caller can fall back.
 */
async function throwIfPolicyDenial(res: { status: number; json(): Promise<unknown> }): Promise<void> {
  if (res.status !== 400 && res.status !== 403) return;
  let code = "request_rejected";
  let message = "The Inistate backend rejected the connection request.";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error) code = body.error;
    if (typeof body.message === "string" && body.message) message = body.message;
  } catch {
    /* keep defaults */
  }
  throw new ConnectionMintDeniedError(code, message);
}

/**
 * Stable per-session key for opaque connection tokens (mode store etc.).
 * Hash, not plaintext, so the secret never becomes a long-lived map key.
 */
export function connectionModeKey(token: string): string {
  return "pat:" + createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/** Decode a JWT payload without verifying the signature. Returns `undefined` if malformed. */
function decodeJwtExp(jwt: string): number | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(payload) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

/** Decode the `sub` claim from a JWT payload without verifying the signature. */
export function decodeJwtSub(jwt: string): string | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(payload) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

function expiresInFromExp(exp: number | undefined): number | undefined {
  if (exp === undefined) return undefined;
  const remaining = exp - Math.floor(Date.now() / 1000);
  return remaining > 0 ? remaining : 0;
}

/* ------------------------------------------------------------------ */
/*  In-memory stores                                                   */
/* ------------------------------------------------------------------ */

interface StoredCode {
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
  state?: string;
  scopes?: string[];
  jwt: string;
  refreshToken?: string;
  createdAt: number;
}

interface PendingAuth {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
  /** Ties the flow to the browser that started it; see browserSecretCookieName (SS05808). */
  browserSecret: string;
}

/**
 * SS05808: the login page POSTs the user's JWT back to /authorize/callback with only the
 * nonce to name the flow, and the nonce travels in the login URL - a referrer leak, an IdP
 * log, or any script on the login page can read it, and whoever holds it could complete
 * the victim's flow with their OWN JWT, so the victim's MCP client would then act inside
 * the attacker's workspace. The flow is therefore also bound to the browser that started
 * it: /authorize sets an HttpOnly cookie the callback must present. app.* and mcp.* share
 * one registrable domain, so a Lax cookie rides the login page's top-level form POST.
 */
export function browserSecretCookieName(nonce: string): string {
  return `mcp_auth_${nonce}`;
}

/** The value of one cookie out of a raw Cookie header, or undefined. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Cookie attributes for the browser-binding cookie: only the callback path ever needs it. */
export function browserSecretCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/authorize",
    maxAge: CODE_TTL_MS,
  };
}

interface IssuedToken {
  clientId: string;
  scopes: string[];
  userId?: string;
  createdAt: number;
}

interface MintedConnection {
  token: string;
  scopes: string[];
  connectionId?: string;
  expiresAt?: string;
}

/*
 * SS05806: the clients store used to be a process-local Map, so every restart wiped every
 * DCR-registered client_id and previously-registered connectors got `invalid_client` at
 * /authorize. FileClientsStore keeps the same shape but survives a restart. See client-store.ts
 * for what is deliberately NOT persisted (tokens, codes, pending auths).
 */

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export class InistateOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: FileClientsStore;
  private codes = new Map<string, StoredCode>();
  private pendingAuth = new Map<string, PendingAuth>();
  private tokens = new Map<string, IssuedToken>();
  private patVerify = new Map<string, { info: AuthInfo; at: number }>();
  private baseUrl: string;
  private appUrl: string;
  private mcpUrl: string;
  private loginPath: string;

  constructor(
    inistateBaseUrl: string,
    appUrl: string,
    mcpUrl: string,
    loginPath: string = "/#/login",
  ) {
    this.clientsStore = new FileClientsStore();
    this.baseUrl = inistateBaseUrl.replace(/\/+$/, "");
    this.appUrl = appUrl.replace(/\/$/, "");
    this.mcpUrl = mcpUrl;
    this.loginPath = loginPath.startsWith("/") ? loginPath : `/${loginPath}`;

    // Periodic cleanup of expired codes and pending auths. unref so the
    // timer never pins the process (tests, embedded use).
    const timer = setInterval(() => this.cleanup(), 60_000);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /* ---- authorize: redirect to app.inistate.com login ---- */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const nonce = randomUUID();
    const browserSecret = randomUUID();
    this.pendingAuth.set(nonce, {
      clientId: client.client_id,
      params,
      createdAt: Date.now(),
      browserSecret,
    });

    // Bind the flow to this browser (SS05808). The SDK hands us the express response;
    // a bare redirect-only response (tests, embedded use) simply gets no cookie.
    const setCookie = (res as unknown as { cookie?: (name: string, value: string, options: object) => void }).cookie;
    if (typeof setCookie === "function") {
      setCookie.call(
        res,
        browserSecretCookieName(nonce),
        browserSecret,
        browserSecretCookieOptions(this.mcpUrl.startsWith("https:")),
      );
    }

    // Redirect to the app's login page with MCP callback params.
    // The path is configurable via INISTATE_APP_LOGIN_PATH; defaults to "/#/login"
    // (Vue hash routing places query params after the hash).
    // mcp_client_name is forwarded so the login banner can read e.g.
    // "Sign in to authorize Claude" instead of "authorize mcp.inistate.com".
    // The name comes from DCR (RFC 7591), so it's client-supplied — Vue must
    // treat it as untrusted display text (no HTML, length-cap on render side).
    const callbackUrl = `${this.mcpUrl}/authorize/callback`;
    const query = new URLSearchParams({
      mcp_nonce: nonce,
      mcp_callback: callbackUrl,
    });
    if (client.client_name) {
      query.set("mcp_client_name", client.client_name);
    }
    // Scopes the connection token will carry, for a future consent UI on the
    // login page. Unknown params are ignored by the current page.
    if (params.scopes?.length) {
      query.set("mcp_scopes", params.scopes.join(" "));
    }
    const loginUrl = `${this.appUrl}${this.loginPath}?${query.toString()}`;

    res.redirect(302, loginUrl);
  }

  /**
   * Called by the /authorize/callback route after the user logs in.
   * Returns the redirect URL with the authorization code.
   */
  completeAuthorization(
    nonce: string,
    jwt: string,
    refreshToken?: string,
    browserSecret?: string,
  ): { redirectUrl: string } {
    const pending = this.pendingAuth.get(nonce);
    if (!pending) throw new Error("Invalid or expired authorization nonce");
    if (Date.now() - pending.createdAt > CODE_TTL_MS) {
      this.pendingAuth.delete(nonce);
      throw new Error("Authorization session expired");
    }
    // SS05808: only the browser that started the flow may finish it. The pending flow is
    // kept, so the legitimate browser can still complete after a stray or forged callback.
    if (!browserSecret || browserSecret !== pending.browserSecret) {
      throw new Error("Authorization session does not belong to this browser");
    }
    this.pendingAuth.delete(nonce);

    const code = randomUUID();
    this.codes.set(code, {
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      clientId: pending.clientId,
      state: pending.params.state,
      scopes: pending.params.scopes,
      jwt,
      refreshToken,
      createdAt: Date.now(),
    });

    const url = new URL(pending.params.redirectUri);
    url.searchParams.set("code", code);
    if (pending.params.state) url.searchParams.set("state", pending.params.state);
    return { redirectUrl: url.toString() };
  }

  /* ---- PKCE ---- */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const stored = this.codes.get(authorizationCode);
    if (!stored) throw new Error("Unknown authorization code");
    return stored.codeChallenge;
  }

  /* ---- Token exchange ---- */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const stored = this.codes.get(authorizationCode);
    if (!stored) throw new Error("Unknown or expired authorization code");
    if (stored.clientId !== client.client_id) throw new Error("Client mismatch");
    if (Date.now() - stored.createdAt > CODE_TTL_MS) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code expired");
    }

    // Single-use
    this.codes.delete(authorizationCode);

    // Requested scopes narrow the grant; no request means the full MCP surface.
    const requested = (stored.scopes ?? []).filter((s) => SUPPORTED_SCOPES.includes(s));
    const scopes = requested.length ? requested : [...SUPPORTED_SCOPES];

    // Preferred path: exchange the short-lived login JWT for a scoped Inistate
    // connection token (PAT). The PAT is the long-lived session credential —
    // it survives JWT expiry, is enforced per-scope by the backend, and shows
    // up on the user's Connections page where it can be revoked.
    let minted: MintedConnection | null;
    try {
      minted = await this.mintConnectionToken(stored.jwt, client, scopes);
    } catch (error) {
      if (error instanceof ConnectionMintDeniedError) {
        // Policy denial (e.g. pricing gate): fail the exchange with the
        // backend's message — never downgrade to a JWT session.
        throw new InvalidGrantError(error.message);
      }
      if (error instanceof ConnectionMintUnavailableError) {
        // Availability failure while Connections is on (SS06119): still never a
        // JWT session - that would bypass the seat gate. The client shows the
        // error and the user connects again once the backend answers.
        throw new TemporarilyUnavailableError(
          "Inistate could not create the connection right now. Please try connecting again.",
        );
      }
      throw error;
    }
    if (minted) {
      this.tokens.set(minted.token, {
        clientId: client.client_id,
        scopes: minted.scopes,
        userId: decodeJwtSub(stored.jwt),
        createdAt: Date.now(),
      });

      const tokens: OAuthTokens = {
        access_token: minted.token,
        token_type: "bearer",
        scope: minted.scopes.join(" "),
      };
      // Non-expiring connection → omit expires_in entirely: the client keeps
      // the session until the user revokes the connection (or it expires).
      if (minted.expiresAt) {
        const seconds = Math.floor((Date.parse(minted.expiresAt) - Date.now()) / 1000);
        if (Number.isFinite(seconds) && seconds > 0) tokens.expires_in = seconds;
      }
      return tokens;
    }

    // Fallback (Connections disabled or backend too old): issue the login JWT
    // directly, with the Inistate refresh token for renewal — the pre-PAT flow.
    this.tokens.set(stored.jwt, {
      clientId: client.client_id,
      scopes,
      userId: decodeJwtSub(stored.jwt),
      createdAt: Date.now(),
    });

    const tokens: OAuthTokens = {
      access_token: stored.jwt,
      token_type: "bearer",
    };
    const expiresIn = expiresInFromExp(decodeJwtExp(stored.jwt));
    if (expiresIn !== undefined) tokens.expires_in = expiresIn;
    if (stored.refreshToken) tokens.refresh_token = stored.refreshToken;
    return tokens;
  }

  /**
   * Mint the Inistate connection token backing this MCP session.
   *
   * One connection per authorization. Connections used to be reused by name
   * (`"<client> (MCP)"`) and rotated, which made two instances of the same
   * client — n8n prod and staging, ChatGPT on two devices — rotate each
   * other's token: the older one died once the overlap window closed
   * (docs/integration-oauth-dcr-proposal.md, I-1). Repeat authorizations now
   * add a row on the Connections page, where the user revokes stale ones;
   * the exchange never touches an existing connection.
   *
   * Reach: the consent step that picks workspaces does not exist yet, so the
   * grant is narrowed only where that is unambiguous — a user with exactly
   * one accessible workspace gets that workspace. Everyone else keeps
   * all-workspace reach (the pre-fix default) rather than a connector that
   * can see nothing until the user widens it on the Connections page.
   *
   * Returns null only when the backend says Connections is off (404: flag off or
   * a backend that predates the feature) — the caller falls back to the JWT flow.
   * Every other failure throws ConnectionMintUnavailableError: a JWT session is
   * never the answer to a mint that merely failed (SS06119).
   */
  private async mintConnectionToken(
    jwt: string,
    client: OAuthClientInformationFull,
    scopes: string[],
  ): Promise<MintedConnection | null> {
    const headers = {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    // Client-supplied display text: strip control chars, cap length.
    const clientLabel = (client.client_name || client.client_id || "MCP client")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .trim()
      .slice(0, 60) || "MCP client";
    // Per-authorization discriminator: tells two sessions of one client apart
    // on the Connections page, and stops a second authorization from finding
    // (and rotating) the first.
    const sessionTag = randomUUID().replace(/-/g, "").slice(0, 6);
    const name = `${clientLabel} (MCP) · ${sessionTag}`;
    const reach = await this.defaultReach(headers.Authorization);
    const body = {
      name,
      description: `OAuth connector session for ${clientLabel}`,
      scopes,
      allWorkspaces: reach.allWorkspaces,
      workspaceIds: reach.workspaceIds,
      expiresAt: null as string | null,
    };

    let createRes: Awaited<ReturnType<typeof fetch>>;
    try {
      createRes = await fetch(`${this.baseUrl}/api/connections`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      // No answer at all. Not "feature off" - the exchange fails (SS06119).
      console.error("Connection mint unreachable; refusing the exchange:", error);
      throw new ConnectionMintUnavailableError(
        `Connection mint unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (createRes.status === 404) {
      // not_enabled — feature flag off on this environment (or a backend that
      // predates Connections). The only answer that still means a JWT session.
      console.log("Connections API disabled on backend; falling back to JWT session");
      return null;
    }
    if (!createRes.ok) {
      // 400/403 are policy answers (pricing gate, limit) — deny the exchange
      // outright. Everything else is an availability problem — also fail, never
      // fall back to an ungated JWT session (SS06119).
      await throwIfPolicyDenial(createRes);
      let detail = "";
      try {
        detail = await createRes.text();
      } catch {
        /* body unreadable; the status is the message */
      }
      console.error(`Connection create failed: HTTP ${createRes.status} ${detail}; refusing the exchange`);
      throw new ConnectionMintUnavailableError(
        `Connection mint failed: HTTP ${createRes.status}`,
        createRes.status,
      );
    }
    let created: { token?: string; connection?: { id?: string; expiresAt?: string } };
    try {
      created = (await createRes.json()) as typeof created;
    } catch (error) {
      console.error("Connection mint answered with an unreadable body; refusing the exchange:", error);
      throw new ConnectionMintUnavailableError("Connection mint returned an unreadable body", createRes.status);
    }
    if (!created?.token || !isConnectionToken(created.token)) {
      // A 2xx without a usable token is a broken backend, not a disabled feature.
      console.error("Connection mint answered without a usable token; refusing the exchange");
      throw new ConnectionMintUnavailableError("Connection mint returned no usable token", createRes.status);
    }
    return {
      token: created.token,
      scopes,
      connectionId: created.connection?.id,
      expiresAt: created.connection?.expiresAt ?? undefined,
    };
  }

  /**
   * Workspace grant for a new OAuth connection: the single accessible
   * workspace when there is exactly one, otherwise all of them. Any failure
   * to read the list keeps the old default — reach must never silently
   * shrink because a lookup hiccuped.
   */
  private async defaultReach(
    authorization: string,
  ): Promise<{ allWorkspaces: boolean; workspaceIds: number[] }> {
    const all = { allWorkspaces: true, workspaceIds: [] as number[] };
    try {
      const res = await fetch(`${this.baseUrl}/api/mcp/workspace`, {
        headers: { Authorization: authorization, Accept: "application/json" },
      });
      if (!res.ok) return all;
      const list = (await res.json()) as unknown;
      if (!Array.isArray(list)) return all;
      const ids = list
        .map((w) => Number((w as { id?: unknown })?.id))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (ids.length === 1) return { allWorkspaces: false, workspaceIds: ids };
      if (ids.length > 1) {
        console.log(
          `OAuth connection keeps all-workspace reach: ${ids.length} workspaces and no consent step picks one yet`,
        );
      }
      return all;
    } catch {
      return all;
    }
  }

  /* ---- Refresh ---- */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
  ): Promise<OAuthTokens> {
    // Only legacy JWT sessions carry a refresh token (PAT sessions don't need
    // one — the connection token itself is long-lived). Forward to Inistate
    // /token with grant_type=refresh_token.
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refreshToken);

    const res = await fetch(`${this.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed: ${text}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const token = (data.token ?? data.access_token ?? data.jwt) as string;

    this.tokens.set(token, {
      clientId: _client.client_id,
      scopes: [],
      userId: decodeJwtSub(token),
      createdAt: Date.now(),
    });

    const tokens: OAuthTokens = {
      access_token: token,
      token_type: "bearer",
    };
    const expiresIn = expiresInFromExp(decodeJwtExp(token));
    if (expiresIn !== undefined) tokens.expires_in = expiresIn;
    const rt = data.refreshToken ?? data.refresh_token;
    if (typeof rt === "string") tokens.refresh_token = rt;
    return tokens;
  }

  /* ---- Token verification ---- */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Tokens issued by this process
    const stored = this.tokens.get(token);
    if (stored) {
      const expiresAt = decodeJwtExp(token); // undefined for ist_ tokens
      return {
        token,
        clientId: stored.clientId,
        scopes: stored.scopes,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(stored.userId ? { extra: { userId: stored.userId } } : {}),
      };
    }

    // Anything else - a connection token minted by another process or before a
    // restart, or a login JWT handed straight to an MCP client - is introspected
    // via /v1/whoami (scope-free by design, only reflects the caller's own
    // token) and cached briefly so revocation still bites. Bearers used to be
    // accepted unverified as "legacy" (SS05807): that made the OAuth layer
    // decorative and let a forged JWT choose whose stored mode a request used.
    return this.introspect(token);
  }

  private async introspect(token: string): Promise<AuthInfo> {
    const cached = this.patVerify.get(token);
    if (cached && Date.now() - cached.at < PAT_VERIFY_TTL_MS) return cached.info;

    const res = await fetch(`${this.baseUrl}/v1/whoami`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      this.patVerify.delete(token);
      throw new Error(
        isConnectionToken(token)
          ? "Connection token is unknown, revoked, or expired"
          : "Bearer token is invalid or expired",
      );
    }
    const data = (await res.json()) as {
      userId?: string;
      connection?: { id?: string; scopes?: string[] };
    };
    const expiresAt = decodeJwtExp(token); // undefined for ist_ tokens
    const info: AuthInfo = {
      token,
      clientId: String(data?.connection?.id ?? (isConnectionToken(token) ? "connection" : "session")),
      scopes: Array.isArray(data?.connection?.scopes) ? data.connection.scopes : [],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(data?.userId ? { extra: { userId: data.userId } } : {}),
    };
    this.patVerify.set(token, { info, at: Date.now() });
    return info;
  }

  /* ---- Revocation ---- */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Drops the session locally. A connection token itself cannot reach the
    // management surface (deny-by-default guard), so authoritative revocation
    // lives on the app's Connections page — which is the product's story for
    // managing MCP sessions anyway.
    this.tokens.delete(request.token);
    this.patVerify.delete(request.token);
  }

  /* ---- Cleanup ---- */
  private cleanup() {
    const now = Date.now();
    for (const [key, val] of this.codes) {
      if (now - val.createdAt > CODE_TTL_MS) this.codes.delete(key);
    }
    for (const [key, val] of this.pendingAuth) {
      if (now - val.createdAt > CODE_TTL_MS) this.pendingAuth.delete(key);
    }
    for (const [key, val] of this.patVerify) {
      if (now - val.at > PAT_VERIFY_TTL_MS) this.patVerify.delete(key);
    }
    for (const [key, val] of this.tokens) {
      // JWT sessions die with the JWT; minted ist_ tokens leave the map after
      // a day and are introspected from then on. Without this the map only
      // ever grew (docs/integration-oauth-dcr-proposal.md, O-0 leak).
      const exp = decodeJwtExp(key);
      const expired = exp !== undefined
        ? exp * 1000 <= now
        : now - val.createdAt > ISSUED_TOKEN_TTL_MS;
      if (expired) this.tokens.delete(key);
    }
  }
}
