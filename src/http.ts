#!/usr/bin/env node

/**
 * Stateless Streamable-HTTP transport for the Inistate MCP server
 * with MCP OAuth 2.0 authorization (Google, Apple, password).
 */

import "dotenv/config";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { requestContext, RequestContext } from "./context.js";
import { InistateOAuthProvider } from "./oauth-provider.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE_URL =
  process.env.INISTATE_API_BASE ||
  process.env.INISTATE_API_URL ||
  process.env.INISTATE_BASE_URL ||
  "https://api.inistate.com";

const ISSUER_URL = process.env.OAUTH_ISSUER_URL || `http://localhost:${PORT}`;
const APP_URL = process.env.INISTATE_APP_URL || "https://app.inistate.com";

const app = express();

/* ------------------------------------------------------------------ */
/*  CORS (must come before routes)                                     */
/* ------------------------------------------------------------------ */

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, Last-Event-ID, x-workspace-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

/* ------------------------------------------------------------------ */
/*  OAuth 2.0 provider                                                 */
/* ------------------------------------------------------------------ */

const oauthProvider = new InistateOAuthProvider(BASE_URL, APP_URL, ISSUER_URL);

// Mount the SDK's OAuth router at root
// Handles: /.well-known/oauth-authorization-server, /authorize, /token, /register
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: new URL(ISSUER_URL),
  baseUrl: new URL(ISSUER_URL),
  resourceServerUrl: new URL("/mcp", ISSUER_URL),
}));

/* ------------------------------------------------------------------ */
/*  OAuth authorize callback (login page POSTs here)                   */
/* ------------------------------------------------------------------ */

app.post("/authorize/callback", express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { nonce, jwt, refreshToken } = req.body;
    if (!nonce || !jwt) {
      res.status(400).send("Missing nonce or jwt");
      return;
    }

    const { redirectUrl } = oauthProvider.completeAuthorization(nonce, jwt, refreshToken || undefined);
    res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("Authorize callback error:", error);
    res.status(400).send(error instanceof Error ? error.message : "Authorization failed");
  }
});

/* ------------------------------------------------------------------ */
/*  Legacy auth endpoints (backward compat + used by login page)       */
/* ------------------------------------------------------------------ */

app.post("/auth/token", express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    const params = new URLSearchParams();
    params.set("grant_type", "password");
    params.set("username", username);
    params.set("password", password);

    const upstream = await fetch(`${BASE_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    });

    const data = (await upstream.json()) as Record<string, unknown>;

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: "Login failed",
        message: data.message || data.error || upstream.statusText,
      });
      return;
    }

    const token = data.token ?? data.access_token ?? data.jwt;
    res.json({
      token,
      token_type: "Bearer",
      refreshToken: data.refreshToken ?? data.refresh_token ?? null,
      usage: `Set header → Authorization: Bearer ${token}`,
    });
  } catch (error) {
    console.error("Auth token error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/auth/external", express.json(), async (req, res) => {
  try {
    const { type } = req.body;

    if (!type || !["google", "apple"].includes(type)) {
      res.status(400).json({ error: 'type must be "google" or "apple"' });
      return;
    }

    // Build ExternalLogin payload
    const externalPayload: Record<string, unknown> = {
      Type: type,
      AutoRegister: true,
      Direct: true,
    };

    if (type === "google") {
      if (req.body.accessToken) {
        externalPayload.AccessToken = req.body.accessToken;
      } else if (req.body.authCode) {
        externalPayload.AuthCode = req.body.authCode;
      } else {
        res.status(400).json({ error: "Google login requires accessToken or authCode" });
        return;
      }
    } else {
      if (!req.body.authCode) {
        res.status(400).json({ error: "Apple login requires authCode" });
        return;
      }
      externalPayload.AuthCode = req.body.authCode;
      if (req.body.redirectUrl) externalPayload.RedirectUrl = req.body.redirectUrl;
      if (req.body.isAppleDevice !== undefined) externalPayload.IsAppleDevice = req.body.isAppleDevice;
    }

    if (req.body.displayName) externalPayload.DisplayName = req.body.displayName;
    if (req.body.email) externalPayload.Email = req.body.email;

    // Step 1: Call Inistate ExternalLogin → get auth code
    const extRes = await fetch(`${BASE_URL}/api/user/ExternalLogin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(externalPayload),
    });

    if (!extRes.ok) {
      const text = await extRes.text();
      res.status(extRes.status).json({ error: "External login failed", message: text });
      return;
    }

    const extData = (await extRes.json()) as Record<string, unknown>;
    const authCode = (extData.authCode ?? extData.AuthCode) as string | undefined;

    if (!authCode) {
      res.status(500).json({ error: "External login did not return an auth code", data: extData });
      return;
    }

    // Step 2: Exchange auth code for JWT
    const tokenParams = new URLSearchParams();
    tokenParams.set("grant_type", "refresh_token");
    tokenParams.set("refresh_token", authCode);

    const tokenRes = await fetch(`${BASE_URL}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: tokenParams.toString(),
    });

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;

    if (!tokenRes.ok) {
      res.status(tokenRes.status).json({
        error: "Token exchange failed",
        message: tokenData.message || tokenData.error,
      });
      return;
    }

    const token = tokenData.token ?? tokenData.access_token ?? tokenData.jwt;
    res.json({
      token,
      token_type: "Bearer",
      refreshToken: tokenData.refreshToken ?? tokenData.refresh_token ?? null,
      usage: `Set header → Authorization: Bearer ${token}`,
    });
  } catch (error) {
    console.error("External auth error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ------------------------------------------------------------------ */
/*  Health check                                                       */
/* ------------------------------------------------------------------ */

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/* ------------------------------------------------------------------ */
/*  MCP endpoint (stateless)                                           */
/* ------------------------------------------------------------------ */

app.post("/mcp", express.raw({ type: "*/*", limit: "4mb" }), async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());

    // Extract per-request auth context from HTTP headers
    const ctx: RequestContext = {
      authorization: req.headers["authorization"] as string | undefined,
      workspaceId: req.headers["x-workspace-id"] as string | undefined,
    };

    await requestContext.run(ctx, async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);

      await transport.close();
      await server.close();
    });
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  console.log(`Inistate MCP HTTP server listening on port ${PORT}`);
  console.log(`  MCP:      POST http://localhost:${PORT}/mcp`);
  console.log(`  OAuth:    GET  http://localhost:${PORT}/.well-known/oauth-authorization-server`);
  console.log(`  Login:    POST http://localhost:${PORT}/auth/token`);
  console.log(`  Social:   POST http://localhost:${PORT}/auth/external`);
  console.log(`  Health:   GET  http://localhost:${PORT}/health`);
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  process.exit(0);
});
