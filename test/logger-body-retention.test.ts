import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { RequestLogger } from "../src/server/logger.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });

async function fixture(deferred: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "r6-storage-body-retention-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, "logs.sqlite");
  const logger = new RequestLogger(200, databasePath, {
    maxDatabaseBytes: 16 * 1024 * 1024, deferStoragePrune: deferred
  });
  cleanup.push(() => logger.close());
  const db = new DatabaseSync(databasePath);
  cleanup.push(() => db.close());
  db.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 100)
    INSERT INTO request_logs(time, route, method, path, status, duration_ms, upstream_host, request_id,
      incoming_request_body, body_status)
    SELECT '2026-11-20T00:00:00.000Z', 'primary', 'POST', '/v1/responses', 200, 1, 'fixture.invalid',
      CAST(n AS TEXT), 'synthetic saved body', 'present' FROM rows`);
  return { logger, db, databasePath };
}

function leaveFreedCheckpointPages(logger: RequestLogger, db: DatabaseSync) {
  logger.providerStateRecovery.configureRetention(1);
  expect(logger.providerStateRecovery.rememberCheckpoint("synthetic-r6-checkpoint", {
    window: [{ type: "compaction", encrypted_content: "synthetic-only" }],
    history: [{ role: "user", content: "x".repeat(1024 * 1024) }],
    fidelity: "exact", prefixHash: null
  }, 1)).toBe(true);
  logger.providerStateRecovery.configureRetention(0);
  expect(db.prepare("SELECT COUNT(*) AS count FROM provider_state_checkpoints").get()?.count).toBe(0);
  expect(Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBeGreaterThan(200);
}

const remainingBodies = (db: DatabaseSync) => Number(db.prepare(
  "SELECT COUNT(*) AS count FROM request_logs WHERE incoming_request_body = 'synthetic saved body'"
).get()?.count);
const bytes = (databasePath: string) => [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
  .reduce((total, file) => total + statSync(file).size, 0);

it("control: preserves bodies at the same quota when no freed checkpoint pages exist", async () => {
  const { logger, db } = await fixture(false);
  logger.configure({ keepRecent: 200, maxDatabaseBytes: 512 * 1024 });
  expect(remainingBodies(db)).toBe(100);
});

it("control: reclaiming checkpoint free pages alone meets the quota with every body intact", async () => {
  const { logger, db, databasePath } = await fixture(false);
  leaveFreedCheckpointPages(logger, db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
  expect(bytes(databasePath)).toBeLessThan(512 * 1024);
  logger.configure({ keepRecent: 200, maxDatabaseBytes: 512 * 1024 });
  expect(remainingBodies(db)).toBe(100);
});

it.each([false, true])("preserves bodies when reclaimable checkpoint free pages suffice, deferred=%s", async deferred => {
  const { logger, db, databasePath } = await fixture(deferred);
  leaveFreedCheckpointPages(logger, db);
  const invalidated = vi.fn();
  logger.addEventListener("storage-pruned", invalidated);
  logger.configure({ keepRecent: 200, maxDatabaseBytes: 512 * 1024 });
  await vi.waitFor(() => expect(bytes(databasePath)).toBeLessThan(512 * 1024));
  expect(logger.getPersistenceHealth().persist_error_count).toBe(0);
  expect(logger.page({ limit: 200, offset: 0 }).total).toBe(100);
  expect(remainingBodies(db)).toBe(100);
  expect(invalidated).not.toHaveBeenCalled();
});

it.each([false, true])("still clears bodies when free-page recovery cannot meet the quota, deferred=%s", async deferred => {
  const { logger, db, databasePath } = await fixture(deferred);
  db.prepare("UPDATE request_logs SET incoming_request_body = ?").run("synthetic-body".repeat(2048));
  leaveFreedCheckpointPages(logger, db);
  const invalidated = vi.fn();
  logger.addEventListener("storage-pruned", invalidated);
  logger.configure({ keepRecent: 200, maxDatabaseBytes: 512 * 1024 });
  await vi.waitFor(() => expect(bytes(databasePath)).toBeLessThan(512 * 1024));
  await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
  expect(db.prepare("SELECT count(*) AS n FROM request_logs WHERE incoming_request_body IS NOT NULL").get()?.n).toBe(0);
  expect(logger.page({ limit: 200, offset: 0 }).total).toBe(100);
});
