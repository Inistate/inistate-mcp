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

  constructor(inistateBaseUrl: string, appUrl: string, mcpUrl: string) {
    this.clientsStore = new InMemoryClientsStore();
    this.baseUrl = inistateBaseUrl;
    this.appUrl = appUrl;
    this.mcpUrl = mcpUrl;

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

    // Redirect to the app's existing login page with MCP callback params.
    // Vue Router uses hash mode, so query params must go after the hash:
    //   app.inistate.com/#/login?mcp_nonce=xxx&mcp_callback=yyy
    const callbackUrl = `${this.mcpUrl}/authorize/callback`;
    const query = new URLSearchParams({
      mcp_nonce: nonce,
      mcp_callback: callbackUrl,
    });
    const loginUrl = `${this.appUrl}/#/login?${query.toString()}`;

    res.redirect(302, loginUrl.toString());
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
    const rt = data.refreshToken ?? data.refresh_token;
    if (typeof rt === "string") tokens.refresh_token = rt;
    return tokens;
  }

  /* ---- Token verification ---- */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check our in-memory store first
    const stored = this.tokens.get(token);
    if (stored) {
      return {
        token,
        clientId: stored.clientId,
        scopes: [],
      };
    }

    // For tokens not issued through OAuth (e.g. direct API key / legacy),
    // accept them but mark with a generic clientId
    return {
      token,
      clientId: "legacy",
      scopes: [],
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
