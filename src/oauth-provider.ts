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
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAT_VERIFY_TTL_MS = 5 * 60 * 1000; // whoami re-check cadence for connection tokens

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
    this.pendingAuth.set(nonce, {
      clientId: client.client_id,
      params,
      createdAt: Date.now(),
    });

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
  ): { redirectUrl: string } {
    const pending = this.pendingAuth.get(nonce);
    if (!pending) throw new Error("Invalid or expired authorization nonce");
    if (Date.now() - pending.createdAt > CODE_TTL_MS) {
      this.pendingAuth.delete(nonce);
      throw new Error("Authorization session expired");
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
   * Mint (or rotate) the Inistate connection token backing this MCP session.
   *
   * One connection per client app: an active connection with the same name is
   * updated to the new grant and rotated (rotation is the only way to get a
   * fresh plaintext token), so repeat authorizations don't pile up rows on the
   * Connections page. The backend keeps the previous token alive for the
   * configured overlap window, so an existing session on another device fades
   * out rather than breaking mid-call.
   *
   * Returns null when the Connections feature is unavailable (flag off, older
   * backend, network failure) — the caller falls back to the JWT flow.
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
    const name = `${clientLabel} (MCP)`;
    const body = {
      name,
      description: `OAuth connector session for ${clientLabel}`,
      scopes,
      allWorkspaces: true,
      workspaceIds: [] as number[],
      expiresAt: null as string | null,
    };

    try {
      const listRes = await fetch(`${this.baseUrl}/api/connections`, {
        headers: { Authorization: headers.Authorization, Accept: headers.Accept },
      });
      if (listRes.status === 404) {
        // not_enabled — feature flag off on this environment
        console.log("Connections API disabled on backend; falling back to JWT session");
        return null;
      }
      if (listRes.ok) {
        const mine = (await listRes.json()) as Array<Record<string, unknown>> | unknown;
        const existing = Array.isArray(mine)
          ? mine.find((c) => c && c.name === name && c.status === "active")
          : undefined;
        const existingId = existing ? String((existing as Record<string, unknown>).id ?? "") : "";
        if (existingId) {
          const reused = await this.updateAndRotate(existingId, body, headers);
          if (reused) return { ...reused, scopes };
          // fall through to create a fresh connection
        }
      }

      const createRes = await fetch(`${this.baseUrl}/api/connections`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!createRes.ok) {
        // 400/403 are policy answers (pricing gate, limit) — deny the exchange
        // outright. Everything else is an availability problem — fall back.
        await throwIfPolicyDenial(createRes);
        console.error(`Connection create failed: HTTP ${createRes.status} ${await createRes.text()}`);
        return null;
      }
      const created = (await createRes.json()) as {
        token?: string;
        connection?: { id?: string; expiresAt?: string };
      };
      if (!created?.token || !isConnectionToken(created.token)) return null;
      return {
        token: created.token,
        scopes,
        connectionId: created.connection?.id,
        expiresAt: created.connection?.expiresAt ?? undefined,
      };
    } catch (error) {
      if (error instanceof ConnectionMintDeniedError) throw error;
      console.error("Connection mint failed; falling back to JWT session:", error);
      return null;
    }
  }

  /** Re-grant (scopes may have changed) then rotate for a fresh plaintext token. */
  private async updateAndRotate(
    connectionId: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<{ token: string; connectionId: string; expiresAt?: string } | null> {
    try {
      const updateRes = await fetch(`${this.baseUrl}/api/connections/${connectionId}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      if (!updateRes.ok) return null;

      const rotateRes = await fetch(`${this.baseUrl}/api/connections/${connectionId}/rotate`, {
        method: "POST",
        headers,
      });
      if (!rotateRes.ok) {
        await throwIfPolicyDenial(rotateRes);
        return null;
      }
      const rotated = (await rotateRes.json()) as {
        token?: string;
        connection?: { id?: string; expiresAt?: string };
      };
      if (!rotated?.token || !isConnectionToken(rotated.token)) return null;
      return {
        token: rotated.token,
        connectionId,
        expiresAt: rotated.connection?.expiresAt ?? undefined,
      };
    } catch (error) {
      if (error instanceof ConnectionMintDeniedError) throw error;
      return null;
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

    // Connection tokens minted by another process (or before a restart):
    // introspect via /v1/whoami — scope-free by design, only reflects the
    // caller's own token — and cache briefly so revocation still bites.
    if (isConnectionToken(token)) {
      const cached = this.patVerify.get(token);
      if (cached && Date.now() - cached.at < PAT_VERIFY_TTL_MS) return cached.info;

      const res = await fetch(`${this.baseUrl}/v1/whoami`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) {
        this.patVerify.delete(token);
        throw new Error("Connection token is unknown, revoked, or expired");
      }
      const data = (await res.json()) as {
        userId?: string;
        connection?: { id?: string; scopes?: string[] };
      };
      const info: AuthInfo = {
        token,
        clientId: String(data?.connection?.id ?? "connection"),
        scopes: Array.isArray(data?.connection?.scopes) ? data.connection.scopes : [],
        ...(data?.userId ? { extra: { userId: data.userId } } : {}),
      };
      this.patVerify.set(token, { info, at: Date.now() });
      return info;
    }

    // For tokens not issued through OAuth (e.g. direct API key / legacy),
    // accept them but mark with a generic clientId — the backend remains the
    // enforcement point for these.
    const expiresAt = decodeJwtExp(token);
    return {
      token,
      clientId: "legacy",
      scopes: [],
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
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
  }
}
