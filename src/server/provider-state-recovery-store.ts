import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isRecord } from "../shared/records.js";
import type { ProviderStateFailure } from "./provider-state-errors.js";
import type { ProviderStateBaseStrategy, ProviderStateFidelity } from "./provider-state-portability.js";

export interface ProviderStateRecoveryPolicy {
  base: ProviderStateBaseStrategy;
  failure: ProviderStateFailure | null;
  stripCompactionIds: boolean;
  priorEncryptedFailures: ProviderStateFailure[];
  rejectedCompaction: boolean;
  unavailable: boolean;
}

export interface ProviderStateCheckpoint {
  window: unknown[];
  history: unknown[];
  fidelity: ProviderStateFidelity;
  prefixHash: string | null;
}

const RULE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RULES = 8192;
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_CHECKPOINT_BYTES = 64 * 1024 * 1024;

/** Shares the logger's connection and lifetime, but owns only recovery tables. */
export class ProviderStateRecoveryStore {
  private activeRetentionHours: number | null = null;
  constructor(private readonly db: DatabaseSync, private readonly onWriteFailure?: (error: unknown) => void) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_state_recovery_plans (
        key TEXT PRIMARY KEY, policy TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS provider_state_checkpoints (
        key TEXT PRIMARY KEY, snapshot TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0),
        updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_provider_state_checkpoints_expiry ON provider_state_checkpoints(expires_at);
    `);
  }

  findPolicy(key: string, now = Date.now()): ProviderStateRecoveryPolicy | null {
    const row = this.db.prepare("SELECT policy FROM provider_state_recovery_plans WHERE key = ? AND expires_at > ?").get(key, now);
    if (!row) return null;
    const policy = parseStoredJson(row.policy, "recovery policy");
    if (!isRecord(policy) || !["original", "cpa", "cross_domain"].includes(String(policy.base)) ||
      !["stripCompactionIds", "rejectedCompaction", "unavailable"].every(key => typeof policy[key] === "boolean") ||
      !Array.isArray(policy.priorEncryptedFailures) || policy.priorEncryptedFailures.length > 3 || !policy.priorEncryptedFailures.every(validStoredFailure) ||
      policy.failure !== null && !validStoredFailure(policy.failure)) {
      throw new Error("Invalid persisted provider-state recovery policy.");
    }
    return policy.unavailable ? null : policy as unknown as ProviderStateRecoveryPolicy;
  }

  rememberPolicy(key: string, policy: ProviderStateRecoveryPolicy, version: number, now = Date.now()): boolean {
    if (policy.unavailable || policy.priorEncryptedFailures.length > 3) return false;
    // Persist only hashes and bounded classifications, never error text or item IDs.
    const failures = [...policy.priorEncryptedFailures, ...(policy.failure ? [policy.failure] : [])];
    if (failures.some(failure => (failure.itemId !== null || failure.inputIndex !== null) && failure.encryptedContentHash === null)) return false;
    const safePolicy = { ...policy, failure: policy.failure ? storedFailure(policy.failure) : null,
      priorEncryptedFailures: policy.priorEncryptedFailures.map(storedFailure) };
    try {
      this.db.prepare(`
        INSERT INTO provider_state_recovery_plans (key, policy, updated_at, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET policy=excluded.policy, updated_at=excluded.updated_at, expires_at=excluded.expires_at
        WHERE excluded.updated_at >= provider_state_recovery_plans.updated_at
      `).run(key, JSON.stringify(safePolicy), version, now + RULE_TTL_MS);
      this.db.prepare("DELETE FROM provider_state_recovery_plans WHERE expires_at <= ?").run(now);
      this.db.prepare(`DELETE FROM provider_state_recovery_plans WHERE key IN (
        SELECT key FROM provider_state_recovery_plans ORDER BY updated_at DESC, key DESC LIMIT -1 OFFSET ?
      )`).run(MAX_RULES);
      return true;
    } catch (error) { return this.reportWriteFailure(error); }
  }

  findCheckpoint(key: string, retentionHours: number, now = Date.now()): ProviderStateCheckpoint | null {
    retentionHours = Math.min(retentionHours, this.activeRetentionHours ?? retentionHours);
    if (retentionHours === 0) return null;
    const row = this.db.prepare(`SELECT snapshot FROM provider_state_checkpoints
      WHERE key = ? AND expires_at > ? AND updated_at > ?`).get(key, now, now - retentionHours * 3_600_000);
    if (!row) return null;
    const snapshot = parseStoredJson(row.snapshot, "checkpoint");
    if (!isRecord(snapshot) || !Array.isArray(snapshot.window) || !Array.isArray(snapshot.history) ||
      !["exact", "summary", "degraded"].includes(String(snapshot.fidelity)) || !nullableHash(snapshot.prefixHash)) {
      throw new Error("Invalid persisted provider-state checkpoint.");
    }
    return snapshot as unknown as ProviderStateCheckpoint;
  }

  rememberCheckpoint(key: string, checkpoint: ProviderStateCheckpoint, retentionHours: number, now = Date.now()): boolean {
    retentionHours = Math.min(retentionHours, this.activeRetentionHours ?? retentionHours);
    if (retentionHours === 0) return false;
    const snapshot = JSON.stringify(checkpoint);
    const bytes = Buffer.byteLength(snapshot);
    if (bytes > MAX_CHECKPOINT_BYTES) return false;
    let transactionOpen = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      this.db.prepare("DELETE FROM provider_state_checkpoints WHERE expires_at <= ?").run(now);
      this.db.prepare(`INSERT INTO provider_state_checkpoints (key,snapshot,bytes,updated_at,expires_at) VALUES (?,?,?,?,?)
        ON CONFLICT(key) DO NOTHING`).run(key, snapshot, bytes, now, now + retentionHours * 3_600_000);
      this.db.prepare(`DELETE FROM provider_state_checkpoints WHERE key IN (
        SELECT key FROM (SELECT key, SUM(bytes) OVER (ORDER BY updated_at DESC,key DESC) AS retained FROM provider_state_checkpoints)
        WHERE retained > ?
      )`).run(MAX_TOTAL_CHECKPOINT_BYTES);
      this.db.exec("COMMIT");
      transactionOpen = false;
      return Boolean(this.db.prepare("SELECT 1 FROM provider_state_checkpoints WHERE key=?").get(key));
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original write failure. */ }
      }
      return this.reportWriteFailure(error);
    }
  }

  purgeCheckpoints(): void {
    this.db.exec("DELETE FROM provider_state_checkpoints");
  }

  configureRetention(hours: number, now = Date.now()): void {
    this.activeRetentionHours = hours;
    if (hours === 0) this.purgeCheckpoints();
    else this.db.prepare("DELETE FROM provider_state_checkpoints WHERE expires_at <= ? OR updated_at <= ?")
      .run(now, now - hours * 3_600_000);
  }

  reportWriteFailure(error: unknown): false {
    if (!this.onWriteFailure) throw error;
    this.onWriteFailure(error);
    return false;
  }
}

function nullableHash(value: unknown): boolean {
  return value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validStoredFailure(value: unknown): boolean {
  return isRecord(value) && ["encrypted_content", "compaction", "continuation", "resource_mismatch"].includes(String(value.kind)) &&
    (value.code === null || ["invalid_encrypted_content", "invalid_responses_request", "previous_response_not_found"].includes(String(value.code))) &&
    ["code", "message"].includes(String(value.evidence)) && value.itemId === null && value.inputIndex === null && nullableHash(value.encryptedContentHash);
}

function storedFailure(failure: ProviderStateFailure): ProviderStateFailure {
  return { ...failure, itemId: null, inputIndex: null };
}

function parseStoredJson(value: unknown, kind: string): unknown {
  try { return JSON.parse(String(value)); }
  catch { throw new Error(`Invalid persisted provider-state ${kind}.`); }
}

export function recoveryHash(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(Buffer.byteLength(part))).update(":").update(part);
  return hash.digest("hex");
}
