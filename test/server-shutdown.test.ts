import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { DebugCaptureWriter } from "../src/server/debug-capture.js";
import { createCompactGateServer, createRequestLogger } from "../src/server/http.js";
import { CodexVersionMonitor } from "../src/server/codex-version.js";
import { ClientIdentityStore } from "../src/server/client-identity-store.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { listen, close } from "./helpers/server-test-lifecycle.js";

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("server resource shutdown", () => {
  it.each([false, true])("drains capture persistence and pruning before SQLite closes (purge=%s)", async (purge) => {
    const dir = await makeConfigDir();
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => res.end(JSON.stringify({ object: "response", output: [], usage: { input_tokens: 1 } })));
    });
    await listen(upstream);
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Missing upstream address");
    const config = await ConfigStore.load(path.join(dir, "config.json"));
    await config.patch({ primary: { base_url: `http://127.0.0.1:${upstreamAddress.port}/v1`, api_key: "synthetic" } });
    const logger = createRequestLogger(config);
    const writer = DebugCaptureWriter.fromConfig(path.join(dir, "captures"), 1024, purge ? 1 : 1024 * 1024,
      (paths) => logger.markCapturesPurged(paths, 50));
    const identity = new ClientIdentityStore({ statePath: path.join(dir, "identity.json"), fetchLatestVersion: async () => null });
    const server = await createCompactGateServer(config, logger, writer, undefined, undefined,
      new CodexVersionMonitor({ probe: () => null }), identity);
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing app address");
    const entered = deferred();
    const release = deferred();
    const write = writer.write.bind(writer);
    vi.spyOn(writer, "write").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return write(...args);
    });
    const closeLogger = vi.spyOn(logger, "close");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic", input: "hello" })
      });
      expect(response.status).toBe(200);
      await response.text();
      await entered.promise;
      let drained = false;
      const shutdown = server.shutdown(20).then(() => { drained = true; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(drained).toBe(false);
      expect(closeLogger).not.toHaveBeenCalled();
      release.resolve();
      await shutdown;
      expect(closeLogger).toHaveBeenCalledOnce();
      expect(logger.getPersistenceHealth().persist_error_count).toBe(0);
      const db = new DatabaseSync(logger.getDatabasePath());
      try {
        const row = db.prepare("SELECT capture_status, capture_path FROM request_logs").get();
        expect(row?.capture_status).toBe(purge ? "purged" : "present");
        if (!purge) expect(JSON.parse(await readFile(String(row?.capture_path), "utf8"))).toHaveProperty("request_id");
      } finally { db.close(); }
    } finally {
      release.resolve();
      await server.shutdown(20);
      await close(upstream);
    }
  });

  it("closes a live Studio stream and is idempotent", async () => {
    const dir = await makeConfigDir();
    const config = await ConfigStore.load(path.join(dir, "config.json"));
    const identity = new ClientIdentityStore({ statePath: path.join(dir, "identity.json"), fetchLatestVersion: async () => null });
    const server = await createCompactGateServer(config, undefined, undefined, undefined, undefined,
      new CodexVersionMonitor({ probe: () => null }), identity);
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`);
    const reader = response.body!.getReader();
    await reader.read();
    const shutdown = server.shutdown(20);
    expect(server.shutdown(20)).toBe(shutdown);
    await shutdown;
    await reader.cancel().catch(() => undefined);
    expect(server.listening).toBe(false);
  });
});
