const BASE_URL =
  process.env.INISTATE_API_BASE ||
  process.env.INISTATE_API_URL ||
  "https://api.inistate.com";

const TOKEN =
  process.env.INISTATE_ACCESS_TOKEN || process.env.INISTATE_API_TOKEN;

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
  return h;
}

function authHeader(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
  return h;
}

function agentAction(status: number): string {
  switch (status) {
    case 400:
      return "Check the error message, correct the input, and retry.";
    case 401:
      return "Bearer token is invalid or expired. Cannot proceed.";
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

export async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
  return handleResponse(res);
}

export async function post(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse(res);
}

export async function put(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handleResponse(res);
}

/**
 * Upload a file via multipart/form-data.
 */
export async function uploadFormData(
  path: string,
  formData: FormData,
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: authHeader(), // no Content-Type — FormData sets boundary
    body: formData,
  });
  return handleResponse(res);
}

/**
 * GET with manual redirect for download_file — returns redirect URL instead of following.
 */
export async function getRaw(
  path: string,
): Promise<{ redirectUrl: string | null; status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: authHeader(),
    redirect: "manual",
  });
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
