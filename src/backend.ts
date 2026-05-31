/**
 * Backend abstraction — the data-plane seam.
 *
 * The MCP server talks to its data plane through this single interface so the
 * identical tool surface runs against either the hosted Inistate Platform
 * (CloudBackend) or, in future, a local runtime (LocalBackend).
 *
 * CloudBackend is the default and delegates to the low-level HTTP client in
 * api.ts (which owns auth, the wsid header, per-request context, and response
 * truncation). This module introduces NO behavioral change: every CloudBackend
 * method issues exactly the request the tool/resource handlers previously made
 * inline.
 *
 * capabilities() describes which features a backend supports. CloudBackend
 * supports everything; a LocalBackend reports the subset its substrate can hold
 * and the rest as unavailable. The descriptor is part of the contract now; the
 * tool surface does not yet adapt to it (that is the next step).
 */

import * as api from "./api.js";

export interface Capabilities {
  /** Multi-tenant workspaces (list_workspaces / set_workspace). */
  workspaces: boolean;
  /** Governed, append-only audit trail (get_entry_history). */
  history: boolean;
  /** File storage (upload / download / presigned URLs). */
  files: boolean;
  /** Identity and role-based authorization. */
  authorization: boolean;
}

export interface ListEntriesParams {
  module: string;
  state?: string;
  search?: string;
  filters?: Record<string, unknown>;
  sortBy?: string;
  sortDirection?: "asc" | "desc";
  currentPage?: number;
  pageSize?: number;
  fields?: string[];
}

export interface GetEntryParams {
  module: string;
  entryId: string | number;
}

export interface GetFormParams {
  module: string;
  activity: string;
  entryId?: string | number | null;
}

export interface GetHistoryParams {
  module: string;
  entryId: string | number;
  page?: number;
}

export interface UploadFileParams {
  module: string;
  name: string;
  fileBase64: string;
  mimeType: string;
}

export interface DownloadFileParams {
  moduleName: string;
  guid: string;
  fileName: string;
}

export interface RequestUploadUrlParams {
  module: string;
  fileName: string;
  contentType: string;
  fileSize: number;
}

export interface ConfirmUploadParams {
  s3Key: string;
}

export interface DownloadResult {
  redirectUrl: string | null;
  status: number;
  body: unknown;
}

/**
 * The data-plane contract. CloudBackend implements every capability; a future
 * LocalBackend implements the subset its substrate supports and reports the
 * rest as unavailable via capabilities().
 *
 * The `submit*` / `*Module` payloads are the wire-shaped command objects the
 * handlers assemble (after their guard, shape, and normalization passes). They
 * are passed through verbatim; documented keys mirror the tool input schemas.
 */
export interface Backend {
  capabilities(): Capabilities;

  /** Set the active workspace for subsequent calls. Context op, no I/O. */
  setActiveWorkspace(wsid: string): void;

  listWorkspaces(search?: string): Promise<unknown>;
  getWorkspace(workspaceId: string): Promise<unknown>;

  listModules(): Promise<unknown>;
  getModuleSchema(module: string, tier: "basic" | "extended"): Promise<unknown>;
  getModuleCanvas(module: string): Promise<unknown>;
  createModule(payload: Record<string, unknown>): Promise<unknown>;
  updateModule(payload: Record<string, unknown>): Promise<unknown>;

  listEntries(params: ListEntriesParams): Promise<unknown>;
  getEntry(params: GetEntryParams): Promise<unknown>;
  getForm(params: GetFormParams): Promise<unknown>;
  submitActivity(payload: Record<string, unknown>): Promise<unknown>;
  submitActivities(payload: Record<string, unknown>): Promise<unknown>;
  getEntryHistory(params: GetHistoryParams): Promise<unknown>;

  uploadFile(params: UploadFileParams): Promise<unknown>;
  downloadFile(params: DownloadFileParams): Promise<DownloadResult>;
  requestUploadUrl(params: RequestUploadUrlParams): Promise<unknown>;
  confirmUpload(params: ConfirmUploadParams): Promise<unknown>;
}

/**
 * The hosted Inistate Platform backend. A thin wrapper over api.ts that builds
 * the same paths and request bodies the handlers used to construct inline.
 */
export class CloudBackend implements Backend {
  capabilities(): Capabilities {
    return { workspaces: true, history: true, files: true, authorization: true };
  }

  setActiveWorkspace(wsid: string): void {
    api.setWorkspaceId(wsid);
  }

  listWorkspaces(search?: string): Promise<unknown> {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    return api.get(`/api/workspace${query}`);
  }

  getWorkspace(workspaceId: string): Promise<unknown> {
    return api.get(`/api/workspace/${api.enc(workspaceId)}`);
  }

  listModules(): Promise<unknown> {
    return api.get("/api/mcp/");
  }

  getModuleSchema(module: string, tier: "basic" | "extended"): Promise<unknown> {
    return api.get(`/api/mcp/${api.enc(module)}?tier=${tier}`);
  }

  getModuleCanvas(module: string): Promise<unknown> {
    return api.get(`/api/configure/${api.enc(module)}`);
  }

  createModule(payload: Record<string, unknown>): Promise<unknown> {
    return api.post("/api/configure", payload);
  }

  updateModule(payload: Record<string, unknown>): Promise<unknown> {
    return api.put("/api/configure", payload);
  }

  listEntries(p: ListEntriesParams): Promise<unknown> {
    const body: Record<string, unknown> = { module: p.module };
    if (p.state) body.state = p.state;
    if (p.search) body.search = p.search;
    if (p.filters) body.filters = p.filters;
    if (p.sortBy) body.sortBy = p.sortBy;
    if (p.sortDirection) body.sortDirection = p.sortDirection;
    if (p.currentPage !== undefined) body.currentPage = p.currentPage;
    if (p.pageSize !== undefined) body.pageSize = p.pageSize;
    if (p.fields && p.fields.length > 0) body.fields = p.fields;
    return api.post("/api/mcp/list", body);
  }

  getEntry(p: GetEntryParams): Promise<unknown> {
    return api.post("/api/mcp/entry", { module: p.module, entryId: p.entryId });
  }

  getForm(p: GetFormParams): Promise<unknown> {
    const body: Record<string, unknown> = { module: p.module, activity: p.activity };
    if (p.entryId !== undefined && p.entryId !== null) body.entryId = p.entryId;
    return api.post("/api/mcp/form", body);
  }

  submitActivity(payload: Record<string, unknown>): Promise<unknown> {
    return api.post("/api/mcp/activity", payload);
  }

  submitActivities(payload: Record<string, unknown>): Promise<unknown> {
    return api.post("/api/mcp/activity/bulk", payload);
  }

  getEntryHistory(p: GetHistoryParams): Promise<unknown> {
    const body: Record<string, unknown> = { module: p.module, entryId: p.entryId };
    if (p.page !== undefined) body.page = p.page;
    return api.post("/api/mcp/history", body);
  }

  uploadFile(p: UploadFileParams): Promise<unknown> {
    const buffer = Buffer.from(p.fileBase64, "base64");
    const blob = new Blob([buffer], { type: p.mimeType });
    const formData = new FormData();
    formData.append("file", blob, p.name);
    formData.append("module", p.module);
    return api.uploadFormData("/api/mcp/upload", formData);
  }

  downloadFile(p: DownloadFileParams): Promise<DownloadResult> {
    return api.getRaw(
      `/api/mcp/download/${api.enc(p.moduleName)}/s/${api.enc(p.guid)}/${api.enc(p.fileName)}`,
    );
  }

  requestUploadUrl(p: RequestUploadUrlParams): Promise<unknown> {
    return api.post("/api/mcp/request-upload-url", {
      module: p.module,
      fileName: p.fileName,
      contentType: p.contentType,
      fileSize: p.fileSize,
    });
  }

  confirmUpload(p: ConfirmUploadParams): Promise<unknown> {
    return api.post("/api/mcp/confirm-upload", { s3Key: p.s3Key });
  }
}
