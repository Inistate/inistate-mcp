import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Authorization header value from the incoming HTTP request (e.g. "fsk ..." or "Bearer ...") */
  authorization?: string;
  /** Workspace ID — set from HTTP header or tool param within this request */
  workspaceId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns true when running inside an HTTP request (stateless mode). */
export function isHttpRequest(): boolean {
  return requestContext.getStore() !== undefined;
}
