import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
  jwt: string;
  refreshToken?: string;
  createdAt: number;
}

interface PendingAuth {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export class InistateOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: InMemoryClientsStore;
  private codes = new Map<string, StoredCode>();
  private pendingAuth = new Map<string, PendingAuth>();
  private tokens = new Map<string, { clientId: string; jwt: string; createdAt: number }>();
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
    this.clientsStore = new InMemoryClientsStore();
    this.baseUrl = inistateBaseUrl;
    this.appUrl = appUrl.replace(/\/$/, "");
    this.mcpUrl = mcpUrl;
    this.loginPath = loginPath.startsWith("/") ? loginPath : `/${loginPath}`;

    // Periodic cleanup of expired codes and pending auths
    setInterval(() => this.cleanup(), 60_000);
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
    const callbackUrl = `${this.mcpUrl}/authorize/callback`;
    const query = new URLSearchParams({
      mcp_nonce: nonce,
      mcp_callback: callbackUrl,
    });
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

    // Track the token for verification
    this.tokens.set(stored.jwt, {
      clientId: client.client_id,
      jwt: stored.jwt,
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

  /* ---- Refresh ---- */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    // Forward to Inistate /token with grant_type=refresh_token
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
      jwt: token,
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
    const expiresAt = decodeJwtExp(token);

    // Check our in-memory store first
    const stored = this.tokens.get(token);
    if (stored) {
      return {
        token,
        clientId: stored.clientId,
        scopes: [],
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      };
    }

    // For tokens not issued through OAuth (e.g. direct API key / legacy),
    // accept them but mark with a generic clientId
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
    this.tokens.delete(request.token);
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
  }
}
