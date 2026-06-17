import { requestContext } from "./context.js";

const BASE_URL = (
  process.env.INISTATE_API_BASE ||
  process.env.INISTATE_API_URL ||
  process.env.INISTATE_BASE_URL ||
  "https://api.inistate.com"
).replace(/\/+$/, "");

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

// Fallback auth from env vars (used when no per-request auth is provided).
// Stdio mode authenticates exclusively via this API token; HTTP mode prefers
// the per-request Authorization header from the OAuth flow.
const ENV_API_KEY =
  process.env.INISTATE_ACCESS_TOKEN ||
  process.env.INISTATE_API_TOKEN ||
  process.env.INISTATE_API_KEY;

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
 * Priority: per-request context header (HTTP/OAuth flow) > env API key (stdio).
 */
function effectiveAuthorization(): string | null {
  const ctx = requestContext.getStore();
  if (ctx?.authorization) return ctx.authorization;
  if (ENV_API_KEY) return `fsk ${ENV_API_KEY}`;
  return null;
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

/**
 * A bare "Module 'X' not found" sends agents hunting across workspaces one
 * set_workspace at a time (observed: 7 calls to locate a module created in
 * the wrong workspace). Anchor the error to the active workspace and name
 * the two possible fixes.
 */
export function annotateModuleNotFound(message: string): string {
  if (!/^module '.+' not found\.?$/i.test(message.trim())) return message;
  const wsid = effectiveWorkspaceId();
  return wsid
    ? `${message.trim().replace(/\.$/, "")} in the active workspace (id ${wsid}). Check list_modules for the exact name, or call set_workspace if the module lives in another workspace.`
    : `${message.trim().replace(/\.$/, "")}. No active workspace is set — call set_workspace (or pass workspaceId) first.`;
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
      message: annotateModuleNotFound(String(body.message || text || res.statusText)),
      details: body.details || null,
      agent_action: agentAction(res.status),
    };
    log("api_error", { status: res.status, url: res.url, error: error.error, message: error.message, details: error.details });
    throw Object.assign(new Error(String(error.message)), { structured: error });
  }
  if (!text) return null;
  const data = JSON.parse(text);

  // §14.8 — truncate large list responses to avoid blowing up agent context.
  // Size-aware: keep as many items as fit the byte budget (a fixed item count
  // either overshoots for wide rows or wastes refetches for narrow ones).
  const TRUNCATE_BUDGET = 30_000;
  if (
    text.length > TRUNCATE_BUDGET &&
    data &&
    typeof data === "object" &&
    Array.isArray(data.list) &&
    data.list.length > 1
  ) {
    const items: unknown[] = data.list;
    const overhead = text.length - JSON.stringify(items).length;
    const budget = Math.max(TRUNCATE_BUDGET - overhead, 2_000);
    let size = 2;
    let keep = 0;
    for (const item of items) {
      const itemLen = JSON.stringify(item).length + 1;
      if (keep > 0 && size + itemLen > budget) break;
      size += itemLen;
      keep++;
    }
    if (keep < items.length) {
      data.list = items.slice(0, keep);
      data._truncated = true;
      data._truncated_message = `Response truncated to ${keep} of ${items.length} items on this page (~30KB cap; ${data.totalItems ?? "unknown"} total). Narrow the payload with the fields parameter (biggest saving) or filters, and paginate with currentPage/pageSize.`;
    }
  }

  return data;
}

/**
 * Core request function. The MCP server no longer manages tokens itself —
 * stdio uses a long-lived API token, HTTP/OAuth passes the client's bearer
 * through. On 401, the caller (or in HTTP mode the OAuth client) is
 * responsible for refreshing.
 */
async function request(
  url: string,
  init: RequestInit,
  getHeaders: () => Record<string, string>,
): Promise<Response> {
  const method = init.method || "GET";
  log("request", { method, url });
  const start = Date.now();
  const res = await fetch(url, { ...init, headers: getHeaders() });
  log("response", { method, url, status: res.status, ms: Date.now() - start });
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
