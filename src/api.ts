const BASE_URL =
  process.env.INISTATE_API_BASE ||
  process.env.INISTATE_API_URL ||
  "https://api.inistate.com";

// API key auth (fsk prefix)
const API_KEY =
  process.env.INISTATE_ACCESS_TOKEN || process.env.INISTATE_API_TOKEN;

// Username/password auth (login → JWT)
const USERNAME = process.env.INISTATE_USERNAME;
const PASSWORD = process.env.INISTATE_PASSWORD;

let jwt: string | null = null;
let refreshToken: string | null = null;
let storedUsername: string | null = USERNAME ?? null;
let storedPassword: string | null = PASSWORD ?? null;
let workspaceId: string | null = null;

export function setWorkspaceId(wsid: string): void {
  workspaceId = wsid;
}

export function getWorkspaceId(): string | null {
  return workspaceId;
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
 */
export async function loginWithCredentials(
  username: string,
  password: string,
): Promise<void> {
  const params = new URLSearchParams();
  params.set("grant_type", "password");
  params.set("username", username);
  params.set("password", password);
  const res = await fetch(`${BASE_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed (${res.status}): ${text}`);
  }
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
  if (API_KEY || jwt) return;
  if (storedUsername && storedPassword) {
    await loginWithCredentials(storedUsername, storedPassword);
  }
}

function authorizationValue(): string | null {
  if (API_KEY) return `fsk ${API_KEY}`;
  if (jwt) return `Bearer ${jwt}`;
  return null;
}

function buildHeaders(contentType?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (contentType) h["Content-Type"] = contentType;
  const auth = authorizationValue();
  if (auth) h["Authorization"] = auth;
  if (workspaceId) h["wsid"] = workspaceId;
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

/** Can we attempt a token refresh? Only for JWT auth, not API key. */
function canRefresh(): boolean {
  return !API_KEY && (!!refreshToken || (!!storedUsername && !!storedPassword));
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
  const res = await fetch(url, { ...init, headers: getHeaders() });
  if (res.status === 401 && canRefresh()) {
    const refreshed = await refreshAuth();
    if (refreshed) {
      return fetch(url, { ...init, headers: getHeaders() });
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
