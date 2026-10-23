import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { RequestLogger } from "../src/server/logger.js";
import { sendBufferedUpstreamRequest } from "../src/server/upstream-client.js";

// Synthetic data only: no config/database path or credentials are accepted.
const mib = Number(process.argv[2] ?? 128);
const mode = process.argv[3] ?? "bodies";
const scheduling = process.argv[4] ?? "cooperative";
assert(Number.isInteger(mib) && mib >= 1 && mib <= 2048, "size must be 1..2048 MiB");
assert(mode === "bodies" || mode === "metadata", "mode must be bodies or metadata");
assert(scheduling === "single-turn" || scheduling === "cooperative", "scheduling must be single-turn or cooperative");
const directory = await mkdtemp(path.join(os.tmpdir(), "compactgate-prune-bench-"));
const databasePath = path.join(directory, "synthetic.sqlite");
const logger = new RequestLogger(20, databasePath, { maxDatabaseBytes: Infinity, deferStoragePrune: scheduling === "cooperative" });
const peer = http.createServer((_req, res) => res.end('{"id":"synthetic","output":[]}'));
const proxy = http.createServer((req, res) => {
  req.resume();
  void sendBufferedUpstreamRequest({ req, res, upstream: new URL(peerUrl), startedAt: performance.now(),
    timeoutMs: 60_000, timeoutMessage: "synthetic timeout", requestHeaders: {}, body: Buffer.alloc(0),
    extraResponseHeaders: {}, writeResponse: true }).catch((error) => res.destroy(error));
});
let peerUrl = "";
let worker: Worker | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
const operations: Record<string, { calls: number; total_ms: number; max_ms: number }> = {};
const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;

function timed<T>(name: string, run: () => T): T {
  const started = performance.now();
  try { return run(); }
  finally {
    const elapsed = performance.now() - started;
    const entry = operations[name] ??= { calls: 0, total_ms: 0, max_ms: 0 };
    entry.calls++;
    entry.total_ms += elapsed;
    entry.max_ms = Math.max(entry.max_ms, elapsed);
  }
}

function footprint() {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .reduce((sum, file) => sum + (existsSync(file) ? statSync(file).size : 0), 0);
}

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

try {
  const seed = new DatabaseSync(databasePath);
  const body = "x".repeat(32 * 1024);
  const rows = Math.ceil(mib * 1024 * 1024 * 1.02 / body.length);
  try {
    const insert = seed.prepare(`INSERT INTO request_logs
      (time, completed_at, route, method, path, status, duration_ms, upstream_host, request_id,
       incoming_request_body, request_summary, body_status, response_model, response_model_source)
      VALUES ('2026-10-23T00:00:00.000Z','2026-10-23T00:00:01.000Z','primary','POST','/v1/responses',
              200,1,'synthetic.invalid',?,?,?,?, 'synthetic','upstream')`);
    seed.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < rows; i++) insert.run(`synthetic-${i}`, mode === "bodies" ? body : null,
      mode === "metadata" ? body : null, mode === "bodies" ? "present" : "none");
    seed.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { seed.close(); }
  const beforeBytes = footprint();
  const cap = mib * 1024 * 1024;
  assert(beforeBytes > cap, "fixture must exceed its cap after checkpoint");
  peerUrl = await listen(peer);
  const proxyUrl = await listen(proxy);

  // A separate event loop launches probes even while the proxy loop is blocked.
  worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const http = require("node:http");
    const { setTimeout: delay } = require("node:timers/promises");
    let stopped = false;
    parentPort.on("message", () => { stopped = true; });
    const latencies = [];
    const errors = [];
    const agent = new http.Agent({ keepAlive: true });
    (async () => {
      while (!stopped) {
        const start = performance.now();
        await new Promise((resolve, reject) => {
          http.get(workerData, { agent }, (res) => {
            res.once("data", () => latencies.push(performance.now() - start));
            res.on("error", reject); res.on("end", resolve); res.resume();
          }).on("error", reject);
        }).catch((error) => errors.push({ code: error.code, message: error.message, duration_ms: performance.now() - start }));
        if (latencies.length + errors.length === 10) parentPort.postMessage({ warm: true });
        await delay(5);
      }
      parentPort.postMessage({ latencies, errors }); agent.destroy(); parentPort.close();
    })().catch((error) => { throw error; });
  `, { eval: true, workerData: proxyUrl });
  const workerFailed = new Promise<never>((_resolve, reject) => worker!.once("error", reject));
  await Promise.race([once(worker, "message"), workerFailed]);
  let maxLoopPauseMs = 0;
  let previousTick = performance.now();
  interval = setInterval(() => {
    const now = performance.now();
    maxLoopPauseMs = Math.max(maxLoopPauseMs, now - previousTick - 5);
    previousTick = now;
  }, 5);
  DatabaseSync.prototype.exec = function (sql) {
    return /^VACUUM/i.test(sql.trim()) ? timed("vacuum", () => originalExec.call(this, sql)) : originalExec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    const operation = /wal_checkpoint/i.test(sql) ? "checkpoint" : /^\s*UPDATE request_logs\s+SET\s+incoming_request_body/i.test(sql)
      ? "clear_bodies" : /^\s*DELETE FROM request_logs/i.test(sql) ? "delete_metadata" : null;
    if (operation) {
      const run = statement.run.bind(statement);
      const get = statement.get.bind(statement);
      statement.run = (...args) => timed(operation, () => run(...args));
      statement.get = (...args) => timed(operation, () => get(...args));
    }
    return statement;
  };
  let complete!: () => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const onPruned = () => complete();
  logger.addEventListener("storage-pruned", onPruned, { once: true });
  const deadline = setTimeout(() => fail(new Error(`Maintenance did not complete within 30s: ${JSON.stringify(logger.getPersistenceHealth())}`)), 30_000);
  const started = performance.now();
  try {
    logger.configure({ keepRecent: 20, maxDatabaseBytes: cap });
    await Promise.race([completed, workerFailed]);
  } finally {
    clearTimeout(deadline);
    logger.removeEventListener("storage-pruned", onPruned);
  }
  const maintenanceMs = performance.now() - started;
  await delay(50);
  const measurements = once(worker, "message");
  worker.postMessage("stop");
  const [sample] = await Promise.race([measurements, workerFailed]) as [{ latencies: number[]; errors: Array<{ code: string; message: string; duration_ms: number }> }];
  const afterBytes = footprint();
  const page = logger.page({ limit: 1, offset: 0 });
  assert(afterBytes <= cap, "maintenance must bring the synthetic database under its cap");
  assert.equal(logger.getPersistenceHealth().persist_error_count, 0);
  if (mode === "bodies") assert.equal(page.total, rows, "body reclaim must preserve metadata");
  assert(page.total > 0);
  console.log(JSON.stringify({ node: process.version, sqlite: process.versions.sqlite, mib, mode, scheduling, rows,
    before_bytes: beforeBytes, after_bytes: afterBytes, remaining_rows: page.total,
    maintenance_ms: maintenanceMs, max_loop_pause_ms: maxLoopPauseMs,
    http_first_byte_max_ms: Math.max(...sample.latencies), http_samples: sample.latencies.length,
    http_error_count: sample.errors.length, http_errors: sample.errors, operations }, null, 2));
} finally {
  DatabaseSync.prototype.exec = originalExec;
  DatabaseSync.prototype.prepare = originalPrepare;
  if (interval) clearInterval(interval);
  await worker?.terminate();
  for (const server of [proxy, peer]) {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  logger.close();
  await rm(directory, { recursive: true, force: true });
}
