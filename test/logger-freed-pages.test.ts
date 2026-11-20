import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { RequestLogger } from "../src/server/logger.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });

async function fixture(deferStoragePrune = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-freed-pages-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const databasePath = path.join(dir, "logs.sqlite");
  const logger = new RequestLogger(200, databasePath, { maxDatabaseBytes: 16 * 1024 * 1024, deferStoragePrune });
  cleanup.push(() => logger.close());
  const writer = new DatabaseSync(databasePath);
  cleanup.push(() => writer.close());
  writer.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 100)
    INSERT INTO request_logs(time, route, method, path, status, duration_ms, upstream_host, request_id)
    SELECT '2026-11-20T00:00:00.000Z', 'primary', 'POST', '/v1/responses', 200, 1, 'fixture.invalid', CAST(n AS TEXT) FROM rows`);
  return { logger, writer, databasePath };
}

function leaveFreedCheckpointPages(logger: RequestLogger, writer: DatabaseSync) {
  logger.providerStateRecovery.configureRetention(1);
  expect(logger.providerStateRecovery.rememberCheckpoint("synthetic-checkpoint", {
    window: [{ type: "compaction", encrypted_content: "synthetic-only" }],
    history: [{ role: "user", content: "x".repeat(1024 * 1024) }],
    fidelity: "exact", prefixHash: null
  }, 1)).toBe(true);
  logger.providerStateRecovery.configureRetention(0);
  expect(writer.prepare("SELECT COUNT(*) AS count FROM provider_state_checkpoints").get()?.count).toBe(0);
  expect(Number(writer.prepare("PRAGMA freelist_count").get()?.freelist_count)).toBeGreaterThan(200);
}

it("preserves metadata when the quota is already satisfied without checkpoint history", async () => {
  const { logger } = await fixture();
  logger.configure({ keepRecent: 200, maxDatabaseBytes: 512 * 1024 });
  expect(logger.page({ limit: 200, offset: 0 }).total).toBe(100);
});

it("preserves metadata after the existing explicit reclaim releases freed checkpoint pages", async () => {
  const { logger, writer, databasePath } = await fixture();
  leaveFreedCheckpointPages(logger, writer);
  expect(await logger.purgeStoredBodies()).toMatchObject({ rows_cleared: 0, row_count_after: 100 });
  expect(statSync(databasePath).size).toBeLessThan(512 * 1024);
  logger.configure({ keepRecent: 200, maxDatabaseBytes: 512 * 1024 });
  expect(logger.page({ limit: 200, offset: 0 }).total).toBe(100);
});

it.each([false, true])("reclaims freed checkpoint pages before deleting unrelated metadata, deferred=%s", async deferred => {
  const { logger, writer, databasePath } = await fixture(deferred);
  leaveFreedCheckpointPages(logger, writer);
  logger.configure({ keepRecent: 200, maxDatabaseBytes: 512 * 1024 });
  await vi.waitFor(() => expect([databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .reduce((total, file) => total + statSync(file).size, 0)).toBeLessThan(512 * 1024));
  const page = logger.page({ limit: 200, offset: 0 });
  expect(logger.getPersistenceHealth().persist_error_count).toBe(0);
  expect(page.total).toBe(100);
});
