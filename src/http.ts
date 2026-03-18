#!/usr/bin/env node

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

const transports = new Map<string, StreamableHTTPServerTransport>();

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handlePost(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const body = await parseBody(req);

  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res, body);
    return;
  }

  if (!sessionId && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  sendJson(res, 400, {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Bad Request: No valid session ID provided" },
    id: null,
  });
}

async function handleGet(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400).end("Invalid or missing session ID");
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

async function handleDelete(req: IncomingMessage, res: ServerResponse) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.writeHead(400).end("Invalid or missing session ID");
    return;
  }
  await transports.get(sessionId)!.handleRequest(req, res);
}

const httpServer = createHttpServer(async (req, res) => {
  // CORS headers for remote clients
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, Last-Event-ID");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404).end("Not Found");
    return;
  }

  try {
    switch (req.method) {
      case "POST":
        await handlePost(req, res);
        break;
      case "GET":
        await handleGet(req, res);
        break;
      case "DELETE":
        await handleDelete(req, res);
        break;
      default:
        res.writeHead(405).end("Method Not Allowed");
    }
  } catch (error) {
    console.error("Error handling request:", error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`Inistate MCP HTTP server listening on port ${PORT}`);
  console.log(`  POST/GET/DELETE http://localhost:${PORT}/mcp`);
  console.log(`  Health check:   http://localhost:${PORT}/health`);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  for (const [id, transport] of transports) {
    await transport.close().catch(() => {});
    transports.delete(id);
  }
  httpServer.close();
  process.exit(0);
});
