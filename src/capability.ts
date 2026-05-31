/**
 * Capability messages (MCP spec §1.6; mirrors inistate-core's capability.ts).
 *
 * The same open MCP server fronts either the hosted Platform (CloudBackend) or
 * an injected backend with a narrower capability set. Platform-only tools are
 * NOT silently absent when the active backend cannot serve them — they return a
 * structured capability message so the agent can explain the gap rather than
 * guess or fabricate.
 *
 * With CloudBackend (the shipped default) every capability is present, so none
 * of this is reachable — it is the contract a reduced-capability backend needs.
 *
 * Two messaging rules:
 *   1. Describe, never govern — present-tense facts, no claim to judge a past.
 *   2. Attribute the limit to the substrate, not to withholding.
 * No crippleware tone, no sales pitch beyond one factual `upgrade` line.
 */

export type CapabilityCode =
  | "workspaces"
  | "governed_history"
  | "files"
  | "authorization"
  | "frontend_guide";

export interface CapabilityMessage {
  error: "capability_unavailable";
  backend: string;
  capability: CapabilityCode;
  message: string;
  upgrade: string;
}

const MESSAGES: Record<CapabilityCode, string> = {
  workspaces:
    "Workspaces are not available on this backend. A local store is a single space on infrastructure you control; multi-tenant workspaces belong to the governed product.",
  governed_history:
    "Governed history is not available on this backend. A local store keeps the current state of each record, not an accountable, append-only record of how it changed.",
  files:
    "File upload and download are not available on this backend. Storing and serving file content is a governed-store capability that a present-state local runtime does not provide.",
  authorization:
    "Authentication and authorization are not available on this backend. A local runtime runs within a local trust boundary and has no user identity to authorize against.",
  frontend_guide:
    "The frontend guide targets the Inistate Platform REST API, which this backend does not serve.",
};

const UPGRADE: Record<CapabilityCode, string> = {
  workspaces: "Connect to the Inistate Platform to enable workspaces.",
  governed_history: "Connect to the Inistate Platform to enable governed history.",
  files: "Connect to the Inistate Platform to enable files.",
  authorization:
    "Connect to the Inistate Platform to enable authentication and authorization.",
  frontend_guide: "Connect to the Inistate Platform to use the frontend guide.",
};

export function capabilityMessage(
  capability: CapabilityCode,
  backend = "local",
): CapabilityMessage {
  return {
    error: "capability_unavailable",
    backend,
    capability,
    message: MESSAGES[capability],
    upgrade: UPGRADE[capability],
  };
}
