/**
 * SS05806 - durable OAuth Dynamic Client Registration store.
 *
 * DCR client_ids used to live only in a process-local Map, so every restart (deploy, crash,
 * container reschedule, `pm2 restart`) wiped them. A connector that had registered days earlier
 * then hit /authorize and got `invalid_client`, and the only way back was to delete and re-add
 * the connector so it registered afresh. Every restart re-broke every cached client.
 *
 * Registrations are now written to a JSON file and reloaded on startup.
 *
 * Deliberately NOT persisted here: issued access tokens, authorization codes and pending auths.
 * Codes and pending auths expire in minutes, so losing them on restart is harmless. Tokens are
 * bearer secrets - writing them to disk is a security tradeoff that deserves its own decision,
 * not a side effect of fixing client registration. Losing them on restart degrades attribution
 * (see verifyAccessToken), it does not lock anyone out the way a lost client_id does.
 *
 * Every disk operation fails soft: if the file cannot be read or written the store keeps working
 * in memory and logs. An unwritable disk must never take authentication down with it.
 *
 * Scope: this is per-process state on local disk, so it fixes restarts, not replicas. If the
 * server is ever scaled out, point OAUTH_CLIENTS_FILE at shared storage or move the map to a DB
 * - otherwise a client registered on one replica is unknown to the others (same caveat
 * mode-store.ts carries).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/** Where registrations are kept. Override for containers that mount a volume elsewhere. */
export function defaultClientsFile(): string {
  return (
    process.env.OAUTH_CLIENTS_FILE ||
    join(process.env.INISTATE_DATA_DIR || ".inistate", "oauth-clients.json")
  );
}

export class FileClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private readonly file: string;
  /** Set when the file is unusable, so we warn once rather than on every registration. */
  private writeDisabled = false;

  constructor(file: string = defaultClientsFile()) {
    this.file = file;
    this.load();
    this.seedFromEnv();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    this.persist();
    return full;
  }

  dump(): OAuthClientInformationFull[] {
    return [...this.clients.values()];
  }

  /* ---------------------------------------------------------------- */

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        console.error(`OAuth client store at ${this.file} is not a JSON array — ignoring it`);
        return;
      }
      for (const entry of parsed) {
        const client = entry as OAuthClientInformationFull;
        // A row without a client_id cannot be looked up; skip rather than poison the map.
        if (client && typeof client.client_id === "string" && client.client_id) {
          this.clients.set(client.client_id, client);
        }
      }
      console.log(`OAuth client store loaded ${this.clients.size} client(s) from ${this.file}`);
    } catch (err) {
      // A corrupt or unreadable file must not stop the server booting. Keep the file for
      // inspection - overwriting it would destroy the only copy of the registrations.
      console.error(`Failed to read OAuth client store at ${this.file}:`, err);
      this.writeDisabled = true;
    }
  }

  /**
   * OAUTH_KNOWN_CLIENTS keeps working exactly as before. Seeded entries are applied AFTER the
   * file load so an operator-pinned client always wins, and are not written back - the env var
   * stays the source of truth for them.
   */
  private seedFromEnv(): void {
    const seed = process.env.OAUTH_KNOWN_CLIENTS;
    if (!seed) return;
    try {
      for (const client of JSON.parse(seed) as OAuthClientInformationFull[]) {
        this.clients.set(client.client_id, client);
      }
      console.log(`OAuth client store seeded with ${this.clients.size} client(s)`);
    } catch {
      console.error("Failed to parse OAUTH_KNOWN_CLIENTS — must be a JSON array");
    }
  }

  private persist(): void {
    if (this.writeDisabled) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // Write-then-rename so a crash mid-write cannot leave a truncated file that would
      // silently drop every registration on the next boot.
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.dump(), null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      this.writeDisabled = true;
      console.error(
        `Failed to persist OAuth client store to ${this.file} — registrations will be lost on restart:`,
        err,
      );
    }
  }
}
