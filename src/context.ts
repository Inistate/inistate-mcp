import { AsyncLocalStorage } from "node:async_hooks";
import type { Mode } from "./mode-store.js";

export interface RequestContext {
  /** Authorization header value from the incoming HTTP request (e.g. "fsk ..." or "Bearer ...") */
  authorization?: string;
  /** Workspace ID — set from HTTP header or tool param within this request */
  workspaceId?: string;
  /** JWT `sub` claim — keys per-user state like the mode store */
  userId?: string;
  /** Mode the server was built in for this request (resolved before McpServer construction) */
  mode?: Mode;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
