/**
 * Per-user mode store. Survives across the stateless HTTP transport's
 * per-request `createServer()` lifecycle, so a user's `switch_mode` choice
 * is remembered for subsequent requests on the same JWT subject.
 *
 * In-memory only — a process restart resets everyone to the env/default mode.
 * For multi-replica deployments, swap the Map for a shared store (Redis, etc.)
 * with the same getUserMode/setUserMode shape.
 */

export type Mode = "runtime" | "configure" | "frontend";

const TTL_MS = 24 * 60 * 60 * 1000;

const userModes = new Map<string, { mode: Mode; lastUsed: number }>();

export function getUserMode(userId: string): Mode | undefined {
  const entry = userModes.get(userId);
  if (!entry) return undefined;
  if (Date.now() - entry.lastUsed > TTL_MS) {
    userModes.delete(userId);
    return undefined;
  }
  entry.lastUsed = Date.now();
  return entry.mode;
}

export function setUserMode(userId: string, mode: Mode): void {
  userModes.set(userId, { mode, lastUsed: Date.now() });
}
