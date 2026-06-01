/**
 * Public library surface for embedding the Inistate MCP server.
 *
 * The same open server fronts either the hosted Platform (the default
 * CloudBackend) or an injected backend with a narrower capability set — e.g.
 * the local runtime (inistate-core). Consumers import `createServer`, implement
 * the `Backend` interface over their own data plane, and inject it:
 *
 *   import { createServer, type Backend } from "inistate-mcp";
 *   const server = createServer({ backend: new MyLocalBackend(), initialMode: "runtime" });
 *
 * The tool surface adapts to `backend.capabilities()`: governance, files,
 * workspaces, history, and scaffold are gated, so a reduced backend surfaces a
 * structured capability message rather than failing or fabricating.
 */

export { createServer, type CreateServerOptions } from "./server.js";

export {
  type Backend,
  type Capabilities,
  CloudBackend,
  type ListEntriesParams,
  type GetEntryParams,
  type GetFormParams,
  type GetHistoryParams,
  type UploadFileParams,
  type DownloadFileParams,
  type RequestUploadUrlParams,
  type ConfirmUploadParams,
  type DownloadResult,
  type ScaffoldModuleParams,
} from "./backend.js";

export {
  capabilityMessage,
  type CapabilityCode,
  type CapabilityMessage,
} from "./capability.js";

export { type Mode } from "./mode-store.js";
