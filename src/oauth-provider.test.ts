import { afterEach, describe, expect, it, vi } from "vitest";
import type { Response as ExpressResponse } from "express";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InistateOAuthProvider,
  SUPPORTED_SCOPES,
  isConnectionToken,
  connectionModeKey,
} from "./oauth-provider.js";

const BASE = "https://api.example.com";
const APP = "https://app.example.com";
const MCP = "https://mcp.example.com";

const PAT = "ist_" + "A".repeat(43);
const ROTATED_PAT = "ist_" + "B".repeat(43);

const CLIENT: OAuthClientInformationFull = {
  client_id: "client-1",
  client_name: "Claude",
  redirect_uris: ["https://client.example/cb"],
};

function jwt(sub: string, expInSec = 3600): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + expInSec })}.sig`;
}

interface RouteResult {
  status?: number;
  body?: unknown;
}

/** Stub global fetch with a `${method} ${pathname}` route table; records calls. */
function mockFetch(routes: Record<string, (body?: unknown) => RouteResult>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response(JSON.stringify({ error: "no_route" }), { status: 500 });
    const out = handler(body);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

/** Drive authorize → login callback → code, returning the authorization code. */
async function obtainCode(
  provider: InistateOAuthProvider,
  opts: { scopes?: string[]; jwt: string; refreshToken?: string },
): Promise<string> {
  let loginUrl = "";
  const res = {
    redirect: (_status: number, url: string) => {
      loginUrl = url;
    },
  } as unknown as ExpressResponse;

  await provider.authorize(
    CLIENT,
    {
      codeChallenge: "challenge",
      redirectUri: "https://client.example/cb",
      state: "st4te",
      scopes: opts.scopes,
    },
    res,
  );

  const nonce = /[?&]mcp_nonce=([^&]+)/.exec(loginUrl)?.[1];
  expect(nonce).toBeTruthy();
  const { redirectUrl } = provider.completeAuthorization(
    decodeURIComponent(nonce!),
    opts.jwt,
    opts.refreshToken,
  );
  const code = new URL(redirectUrl).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token helpers", () => {
  it("recognizes connection tokens by shape", () => {
    expect(isConnectionToken(PAT)).toBe(true);
    expect(isConnectionToken("ist_short")).toBe(false);
    expect(isConnectionToken(jwt("u1"))).toBe(false);
    expect(isConnectionToken(undefined)).toBe(false);
  });

  it("derives a stable, non-secret mode key", () => {
    const key = connectionModeKey(PAT);
    expect(key).toMatch(/^pat:[0-9a-f]{16}$/);
    expect(connectionModeKey(PAT)).toBe(key);
    expect(connectionModeKey(ROTATED_PAT)).not.toBe(key);
    expect(key).not.toContain(PAT.slice(4));
  });
});

describe("exchangeAuthorizationCode → connection token", () => {
  it("mints a scoped PAT and returns it as a long-lived access token", async () => {
    const { calls } = mockFetch({
      "GET /api/connections": () => ({ body: [] }),
      "POST /api/connections": (body) => ({
        body: { connection: { id: "conn-1", expiresAt: null }, token: PAT },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, {
      jwt: jwt("user-1"),
      refreshToken: "rt-1",
      scopes: ["data.entries:read", "not-a-real-scope"],
    });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    expect(tokens.access_token).toBe(PAT);
    expect(tokens.token_type).toBe("bearer");
    // Requested scopes narrowed to the known vocabulary
    expect(tokens.scope).toBe("data.entries:read");
    // The PAT is the long-lived credential: no refresh token, no expiry
    expect(tokens.refresh_token).toBeUndefined();
    expect(tokens.expires_in).toBeUndefined();

    const create = calls.find((c) => c.method === "POST" && c.path === "/api/connections");
    expect(create?.body).toMatchObject({
      scopes: ["data.entries:read"],
      allWorkspaces: true,
    });
    // Per-authorization name: the client label plus a short session tag.
    expect((create?.body as { name: string }).name).toMatch(/^Claude \(MCP\) · [0-9a-f]{6}$/);
  });

  it("grants the full scope set when the client requests none", async () => {
    const { calls } = mockFetch({
      "GET /api/connections": () => ({ body: [] }),
      "POST /api/connections": () => ({
        body: { connection: { id: "conn-1", expiresAt: null }, token: PAT },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, { jwt: jwt("user-1") });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    expect(tokens.scope).toBe(SUPPORTED_SCOPES.join(" "));
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/connections");
    expect(create?.body).toMatchObject({ scopes: SUPPORTED_SCOPES });
  });

  it("never touches an existing connection: a second authorization gets its own row", async () => {
    // Two instances of one client (n8n prod + staging, ChatGPT on two devices)
    // used to land on the same "<client> (MCP)" row and rotate each other's
    // token; the older instance died once the overlap window closed.
    const { calls } = mockFetch({
      "GET /api/connections": () => ({
        body: [{ id: "conn-9", name: "Claude (MCP)", status: "active" }],
      }),
      "POST /api/connections": () => ({
        body: { connection: { id: "conn-10", expiresAt: null }, token: PAT },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, { jwt: jwt("user-1") });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    expect(tokens.access_token).toBe(PAT);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/rotate"))).toBe(false);
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/connections");
    expect((create?.body as { name: string }).name).not.toBe("Claude (MCP)");
  });

  it("narrows a single-workspace user to that workspace", async () => {
    const { calls } = mockFetch({
      "GET /api/mcp/workspace": () => ({ body: [{ id: 7, name: "Ops" }] }),
      "POST /api/connections": () => ({
        body: { connection: { id: "conn-1", expiresAt: null }, token: PAT },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, { jwt: jwt("user-1") });
    await provider.exchangeAuthorizationCode(CLIENT, code);

    const create = calls.find((c) => c.method === "POST" && c.path === "/api/connections");
    expect(create?.body).toMatchObject({ allWorkspaces: false, workspaceIds: [7] });
  });

  it("keeps all-workspace reach when the user has several workspaces (no consent step yet)", async () => {
    const { calls } = mockFetch({
      "GET /api/mcp/workspace": () => ({
        body: [{ id: 7, name: "Ops" }, { id: 8, name: "Finance" }],
      }),
      "POST /api/connections": () => ({
        body: { connection: { id: "conn-1", expiresAt: null }, token: PAT },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, { jwt: jwt("user-1") });
    await provider.exchangeAuthorizationCode(CLIENT, code);

    const create = calls.find((c) => c.method === "POST" && c.path === "/api/connections");
    expect(create?.body).toMatchObject({ allWorkspaces: true, workspaceIds: [] });
  });

  it("maps a connection expiry to expires_in", async () => {
    const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
    mockFetch({
      "GET /api/connections": () => ({ body: [] }),
      "POST /api/connections": () => ({
        body: { connection: { id: "conn-1", expiresAt }, token: PAT },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, { jwt: jwt("user-1") });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    expect(tokens.expires_in).toBeGreaterThan(89 * 24 * 3600);
    expect(tokens.expires_in).toBeLessThanOrEqual(90 * 24 * 3600);
  });

  it("falls back to the JWT session when Connections is disabled (404)", async () => {
    mockFetch({
      "GET /api/connections": () => ({ status: 404, body: { error: "not_enabled" } }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const userJwt = jwt("user-1", 3600);
    const code = await obtainCode(provider, { jwt: userJwt, refreshToken: "rt-1" });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    expect(tokens.access_token).toBe(userJwt);
    expect(tokens.refresh_token).toBe("rt-1");
    expect(tokens.expires_in).toBeGreaterThan(3500);
  });

  it("falls back to the JWT session when the mint request fails transiently", async () => {
    mockFetch({
      "GET /api/connections": () => ({ body: [] }),
      "POST /api/connections": () => ({ status: 500, body: { error: "server_error" } }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const userJwt = jwt("user-1");
    const code = await obtainCode(provider, { jwt: userJwt, refreshToken: "rt-1" });
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code);

    expect(tokens.access_token).toBe(userJwt);
    expect(tokens.refresh_token).toBe("rt-1");
  });

  it("denies the exchange when the pricing gate rejects the user (no JWT fallback)", async () => {
    mockFetch({
      "GET /api/connections": () => ({ body: [] }),
      "POST /api/connections": () => ({
        status: 403,
        body: {
          error: "connections_not_permitted",
          message: "API connections are not included in your current membership plan.",
        },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, { jwt: jwt("lite-user"), refreshToken: "rt-1" });

    await expect(provider.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow(
      /membership plan/,
    );
  });

  it("denies the exchange on policy 400s (e.g. limit_reached) instead of downgrading", async () => {
    mockFetch({
      "GET /api/connections": () => ({ body: [] }),
      "POST /api/connections": () => ({
        status: 400,
        body: { error: "limit_reached", message: "You already have 50 active connections." },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, { jwt: jwt("user-1"), refreshToken: "rt-1" });

    await expect(provider.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow(
      /50 active connections/,
    );
  });

});

describe("issued-token map hygiene", () => {
  it("forgets a minted connection token after a day and introspects it instead", async () => {
    vi.useFakeTimers();
    try {
      const { calls } = mockFetch({
        "POST /api/connections": () => ({
          body: { connection: { id: "conn-1", expiresAt: null }, token: PAT },
        }),
        "GET /v1/whoami": () => ({
          body: { userId: "user-1", connection: { id: "conn-1", scopes: ["data.entries:read"] } },
        }),
      });

      const provider = new InistateOAuthProvider(BASE, APP, MCP);
      const code = await obtainCode(provider, { jwt: jwt("user-1", 48 * 3600) });
      await provider.exchangeAuthorizationCode(CLIENT, code);
      await provider.verifyAccessToken(PAT);
      expect(calls.some((c) => c.path === "/v1/whoami")).toBe(false);

      // The cleanup timer fires every minute; a day later the local entry is gone.
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 61_000);

      const info = await provider.verifyAccessToken(PAT);
      expect(info.clientId).toBe("conn-1");
      expect(calls.some((c) => c.path === "/v1/whoami")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("verifyAccessToken", () => {
  it("returns scopes for tokens minted in this process without a backend call", async () => {
    const { fn } = mockFetch({
      "GET /api/connections": () => ({ body: [] }),
      "POST /api/connections": () => ({
        body: { connection: { id: "conn-1", expiresAt: null }, token: PAT },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const code = await obtainCode(provider, {
      jwt: jwt("user-1"),
      scopes: ["data.entries:read"],
    });
    await provider.exchangeAuthorizationCode(CLIENT, code);
    fn.mockClear();

    const info = await provider.verifyAccessToken(PAT);
    expect(info.clientId).toBe(CLIENT.client_id);
    expect(info.scopes).toEqual(["data.entries:read"]);
    expect(info.extra?.userId).toBe("user-1");
    expect(fn).not.toHaveBeenCalled();
  });

  it("introspects unknown connection tokens via /v1/whoami and caches", async () => {
    const { fn } = mockFetch({
      "GET /v1/whoami": () => ({
        body: {
          userId: "user-7",
          userName: "someone@example.com",
          callerKind: "api",
          connection: { id: "conn-7", scopes: ["data.entries:read", "user:read"] },
        },
      }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const info = await provider.verifyAccessToken(PAT);
    expect(info.clientId).toBe("conn-7");
    expect(info.scopes).toEqual(["data.entries:read", "user:read"]);
    expect(info.extra?.userId).toBe("user-7");

    await provider.verifyAccessToken(PAT);
    expect(fn).toHaveBeenCalledTimes(1); // second hit served from cache
  });

  it("rejects revoked or unknown connection tokens", async () => {
    mockFetch({
      "GET /v1/whoami": () => ({ status: 401, body: { error: "invalid_token" } }),
    });

    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    await expect(provider.verifyAccessToken(PAT)).rejects.toThrow(/revoked|expired|unknown/i);
  });

  it("keeps the legacy passthrough for non-connection bearer tokens", async () => {
    mockFetch({});
    const provider = new InistateOAuthProvider(BASE, APP, MCP);
    const info = await provider.verifyAccessToken(jwt("user-2", 60));
    expect(info.clientId).toBe("legacy");
    expect(info.expiresAt).toBeDefined();
  });
});
