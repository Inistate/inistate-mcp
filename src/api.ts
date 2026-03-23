import { requestContext, isHttpRequest } from "./context.js";

const BASE_URL =
  process.env.INISTATE_API_BASE ||
  process.env.INISTATE_API_URL ||
  process.env.INISTATE_BASE_URL ||
  "https://api.inistate.com";

const LOG_ENABLED = process.env.INISTATE_LOG !== "0";

function log(message: string, data?: Record<string, unknown>): void {
  if (!LOG_ENABLED) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    msg: message,
    ...data,
  };
  console.error(JSON.stringify(entry));
}

// Fallback auth from env vars (used when no per-request auth is provided)
const ENV_API_KEY =
  process.env.INISTATE_ACCESS_TOKEN ||
  process.env.INISTATE_API_TOKEN ||
  process.env.INISTATE_API_KEY;

// Username/password auth (login → JWT) — only for stdio/session mode
const USERNAME = process.env.INISTATE_USERNAME;
const PASSWORD = process.env.INISTATE_PASSWORD;

let jwt: string | null = null;
let refreshToken: string | null = null;
let storedUsername: string | null = USERNAME ?? null;
let storedPassword: string | null = PASSWORD ?? null;
let workspaceId: string | null = process.env.INISTATE_WORKSPACE_ID ?? null;

export function setWorkspaceId(wsid: string): void {
  const ctx = requestContext.getStore();
  if (ctx) {
    // HTTP mode: write to per-request context, not the global
    ctx.workspaceId = wsid;
  } else {
    // stdio/session mode: write to the global
    workspaceId = wsid;
  }
}

export function getWorkspaceId(): string | null {
  return workspaceId;
}

/**
 * Resolve the effective workspace ID.
 * Priority: per-request context header > tool param (via setWorkspaceId) > env var
 */
function effectiveWorkspaceId(): string | null {
  const ctx = requestContext.getStore();
  return ctx?.workspaceId || workspaceId;
}

/**
 * Resolve the effective Authorization header value.
 * Priority: per-request context header > env API key > JWT from login
 */
function effectiveAuthorization(): string | null {
  const ctx = requestContext.getStore();
  if (ctx?.authorization) return ctx.authorization;
  if (ENV_API_KEY) return `fsk ${ENV_API_KEY}`;
  if (jwt) return `Bearer ${jwt}`;
  return null;
}

function extractTokens(data: Record<string, unknown>): void {
  const token = data.token ?? data.access_token ?? data.jwt;
  if (typeof token !== "string") {
    throw new Error("Login response did not contain a token");
  }
  jwt = token;
  const rt = data.refreshToken ?? data.refresh_token;
  if (typeof rt === "string") refreshToken = rt;
}

/**
 * Login with username/password to obtain a JWT + refresh token.
 * Only available in stdio/session mode — in HTTP mode, clients must
 * pass their own Authorization header.
 */
export async function loginWithCredentials(
  username: string,
  password: string,
): Promise<void> {
  if (isHttpRequest()) {
    throw new Error(
      "Login is not supported in remote/HTTP mode. Pass your API key or JWT via the Authorization header instead."
    );
  }
  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("username", username);
  params.set("password", password);
  log("login", { username });
  const res = await fetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    log("login_failed", { status: res.status, body: text });
    throw new Error(`Login failed (${res.status}): ${text}`);
  }
  log("login_success", { username });
  const data = (await res.json()) as Record<string, unknown>;
  extractTokens(data);
  // Store credentials for future re-login if refresh token is not available
  storedUsername = username;
  storedPassword = password;
}

/**
 * Refresh the JWT using the refresh token.
 * Falls back to full re-login if refresh fails or no refresh token exists.
 */
async function refreshAuth(): Promise<boolean> {
  if (refreshToken) {
    try {
      const res = await fetch(`${BASE_URL}/token/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        extractTokens(data);
        return true;
      }
    } catch {
      // refresh failed — fall through to re-login
    }
  }
  // Fall back to re-login with stored credentials
  if (storedUsername && storedPassword) {
    try {
      await loginWithCredentials(storedUsername, storedPassword);
      return true;
    } catch {
      // re-login also failed
    }
  }
  return false;
}

async function ensureAuth(): Promise<void> {
  // Per-request auth from HTTP header takes priority — no login needed
  const ctx = requestContext.getStore();
  if (ctx?.authorization) return;
  if (ENV_API_KEY || jwt) return;
  if (storedUsername && storedPassword) {
    await loginWithCredentials(storedUsername, storedPassword);
  }
}

function buildHeaders(contentType?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (contentType) h["Content-Type"] = contentType;
  const auth = effectiveAuthorization();
  if (auth) h["Authorization"] = auth;
  const wsid = effectiveWorkspaceId();
  if (wsid) h["wsid"] = wsid;
  return h;
}

function headers(): Record<string, string> {
  return buildHeaders("application/json");
}

function authHeader(): Record<string, string> {
  return buildHeaders();
}

function agentAction(status: number): string {
  switch (status) {
    case 400:
      return "Check the error message, correct the input, and retry.";
    case 401:
      return "API key or token is invalid or expired. Check credentials and retry.";
    case 403:
      return "User lacks access to this resource. Inform the user.";
    case 404:
      return "Resource not found. Verify the module name or entry ID.";
    case 422:
      return "Validation failed. Check details[].field and details[].message for specifics.";
    default:
      return "Unexpected error. Report to user.";
  }
}

async function handleResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    const error = {
      error: body.error || `HTTP ${res.status}`,
      message: body.message || text || res.statusText,
      details: body.details || null,
      agent_action: agentAction(res.status),
    };
    log("api_error", { status: res.status, url: res.url, error: error.error, message: error.message, details: error.details });
    throw Object.assign(new Error(String(error.message)), { structured: error });
  }
  if (!text) return null;
  const data = JSON.parse(text);

  // §14.8 — truncate large list responses to avoid blowing up agent context
  if (
    text.length > 100_000 &&
    data &&
    typeof data === "object" &&
    Array.isArray(data.list)
  ) {
    data.list = data.list.slice(0, 20);
    data._truncated = true;
    data._truncated_message = `Response truncated to 20 of ${data.totalItems ?? "unknown"} items. Use pagination (currentPage, pageSize) to retrieve more.`;
  }

  return data;
}

/** Can we attempt a token refresh? Only for JWT auth, not API key or pass-through. */
function canRefresh(): boolean {
  const ctx = requestContext.getStore();
  if (ctx?.authorization) return false; // pass-through auth — server can't refresh client's token
  return !ENV_API_KEY && (!!refreshToken || (!!storedUsername && !!storedPassword));
}

/**
 * Core request function with automatic 401 refresh+retry.
 */
async function request(
  url: string,
  init: RequestInit,
  getHeaders: () => Record<string, string>,
): Promise<Response> {
  await ensureAuth();
  const method = init.method || "GET";
  log("request", { method, url });
  const start = Date.now();
  const res = await fetch(url, { ...init, headers: getHeaders() });
  log("response", { method, url, status: res.status, ms: Date.now() - start });
  if (res.status === 401 && canRefresh()) {
    log("auth_refresh", { url });
    const refreshed = await refreshAuth();
    if (refreshed) {
      log("request_retry", { method, url });
      const retryStart = Date.now();
      const retryRes = await fetch(url, { ...init, headers: getHeaders() });
      log("response_retry", { method, url, status: retryRes.status, ms: Date.now() - retryStart });
      return retryRes;
    }
  }
  return res;
}

export async function get(path: string): Promise<unknown> {
  const res = await request(`${BASE_URL}${path}`, {}, headers);
  return handleResponse(res);
}

export async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await request(
    `${BASE_URL}${path}`,
    {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    headers,
  );
  return handleResponse(res);
}

export async function put(path: string, body?: unknown): Promise<unknown> {
  const res = await request(
    `${BASE_URL}${path}`,
    {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    headers,
  );
  return handleResponse(res);
}

/**
 * Upload a file via multipart/form-data.
 */
export async function uploadFormData(
  path: string,
  formData: FormData,
): Promise<unknown> {
  const res = await request(
    `${BASE_URL}${path}`,
    { method: "POST", body: formData },
    authHeader,
  );
  return handleResponse(res);
}

/**
 * GET with manual redirect for download_file — returns redirect URL instead of following.
 */
export async function getRaw(
  path: string,
): Promise<{ redirectUrl: string | null; status: number; body: unknown }> {
  const res = await request(
    `${BASE_URL}${path}`,
    { redirect: "manual" },
    authHeader,
  );
  if (res.status === 302 || res.status === 301) {
    return {
      redirectUrl: res.headers.get("Location"),
      status: res.status,
      body: null,
    };
  }
  const data = await handleResponse(res);
  return { redirectUrl: null, status: res.status, body: data };
}

export function enc(s: string): string {
  return encodeURIComponent(s);
}
