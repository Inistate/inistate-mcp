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
import { InistateOAuthProvider, decodeJwtSub } from "./oauth-provider.js";
import { getUserMode } from "./mode-store.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE_URL =
  process.env.INISTATE_API_BASE ||
  process.env.INISTATE_API_URL ||
  process.env.INISTATE_BASE_URL ||
  "https://api.inistate.com";

const ISSUER_URL = process.env.OAUTH_ISSUER_URL || `http://localhost:${PORT}`;
const APP_URL = process.env.INISTATE_APP_URL || "https://app.inistate.com";
const APP_LOGIN_PATH = process.env.INISTATE_APP_LOGIN_PATH || "/#/login";

const app = express();

/* ------------------------------------------------------------------ */
/*  CORS (must come before routes)                                     */
/* ------------------------------------------------------------------ */

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Last-Event-ID, x-workspace-id");
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

const oauthProvider = new InistateOAuthProvider(BASE_URL, APP_URL, ISSUER_URL, APP_LOGIN_PATH);

const PROTECTED_RESOURCE_METADATA_URL = `${ISSUER_URL.replace(/\/$/, "")}/.well-known/oauth-protected-resource/mcp`;

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
/*  Health check                                                       */
/* ------------------------------------------------------------------ */

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/* ------------------------------------------------------------------ */
/*  MCP endpoint (stateless)                                           */
/* ------------------------------------------------------------------ */

function sendUnauthorized(res: express.Response, description: string) {
  res.set(
    "WWW-Authenticate",
    `Bearer realm="mcp", error="invalid_token", error_description="${description}", resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`,
  );
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: description },
    id: null,
  });
}

app.get("/mcp", (_req, res) => sendUnauthorized(res, "Missing Authorization header"));
app.delete("/mcp", (_req, res) => sendUnauthorized(res, "Missing Authorization header"));

app.post("/mcp", express.raw({ type: "*/*", limit: "4mb" }), async (req, res) => {
  try {
    const authHeader = req.headers["authorization"] as string | undefined;
    if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) {
      sendUnauthorized(res, "Missing or malformed Authorization header");
      return;
    }

    const body = JSON.parse(req.body.toString());

    // Extract per-request auth context from HTTP headers
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    const userId = decodeJwtSub(bearer);
    const mode = userId ? getUserMode(userId) : undefined;

    const ctx: RequestContext = {
      authorization: authHeader,
      workspaceId: req.headers["x-workspace-id"] as string | undefined,
      userId,
      mode,
    };

    await requestContext.run(ctx, async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const server = createServer({ initialMode: mode });
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

app.get("/.well-known/openai-apps-challenge", (_, res) => {
  const data = process.env.OPENAI_VERIFICATION_TOKEN;
  if (!data) {
    res.status(404).type('text/plain').send("Not found");
  }
  res.status(200).type("text/plain").send(data);
})

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  console.log(`Inistate MCP HTTP server listening on port ${PORT}`);
  console.log(`  MCP:      POST http://localhost:${PORT}/mcp`);
  console.log(`  OAuth:    GET  http://localhost:${PORT}/.well-known/oauth-authorization-server`);
  console.log(`  Health:   GET  http://localhost:${PORT}/health`);
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  process.exit(0);
});
