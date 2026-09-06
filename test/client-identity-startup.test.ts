import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientIdentityStore } from "../src/server/client-identity-store.js";
import { ConfigStore } from "../src/server/config.js";
import { CodexVersionMonitor } from "../src/server/codex-version.js";
import { createCompactGateServer } from "../src/server/http.js";
import { close, listen } from "./helpers/server-test-lifecycle.js";
import { openSseStream, postJson } from "./helpers/server-test-utils.js";

const cleanup: Array<() => Promise<void>> = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

async function setupIdentity(fetchLatestVersion: () => Promise<string | null> = async () => null) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compactgate-identity-startup-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const config = await ConfigStore.load(path.join(dir, "config.json"));
  const statePath = path.join(dir, "identity.json");
  const identity = new ClientIdentityStore({ statePath, fetchLatestVersion });
  return { config, statePath, identity };
}

async function startServer(config: ConfigStore, identity: ClientIdentityStore) {
  const server = await createCompactGateServer(
    config, undefined, undefined, undefined, undefined,
    new CodexVersionMonitor({ probe: () => null }), identity
  );
  await listen(server);
  cleanup.push(async () => {
    await close(server);
    await identity.flush();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

describe("identity startup and API integrity", () => {
  it("waits for local settings but never waits for registry requests to listen", async () => {
    const registry = deferred<string | null>();
    const { config, identity, statePath } = await setupIdentity(() => registry.promise);
    await fs.writeFile(statePath, JSON.stringify({ enabled: false }));
    const disk = deferred<void>();
    const load = identity.load.bind(identity);
    vi.spyOn(identity, "load").mockImplementation(() => disk.promise.then(load));
    let ready = false;
    const starting = startServer(config, identity).then((url) => { ready = true; return url; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ready).toBe(false);
    disk.resolve();
    const url = await starting;
    const response = await fetch(`${url}/api/client-identity`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false });
    registry.resolve(null);
    await identity.start();
  });

  it("refuses server creation when the saved identity file is corrupt", async () => {
    const { config, identity, statePath } = await setupIdentity();
    await fs.writeFile(statePath, "{broken");
    await expect(createCompactGateServer(
      config, undefined, undefined, undefined, undefined,
      new CodexVersionMonitor({ probe: () => null }), identity
    )).rejects.toThrow("Could not load client identity state");
    expect(await fs.readFile(statePath, "utf8")).toBe("{broken");
  });

  it("returns HTTP 500 on a failed save and can retry after the filesystem is repaired", async () => {
    const { config, identity, statePath } = await setupIdentity();
    await identity.start();
    const url = await startServer(config, identity);
    const saved = await fs.readFile(statePath, "utf8");
    const temporary = `${statePath}.${process.pid}.tmp`;
    await fs.mkdir(temporary);
    try {
      const response = await postJson(url, "/api/client-identity", { enabled: false });
      expect(response.status).toBe(500);
      expect(await response.json()).toHaveProperty("error");
      expect(await fs.readFile(statePath, "utf8")).toBe(saved);
    } finally {
      await fs.rm(temporary, { recursive: true });
      const response = await postJson(url, "/api/client-identity", { enabled: true });
      expect(response.status).toBe(200);
      await response.text();
    }
  });

  it("broadcasts automatic extraction and registry failure metadata to Studio", async () => {
    const { config, identity } = await setupIdentity();
    await identity.start();
    const url = await startServer(config, identity);
    const sse = await openSseStream(`${url}/api/events`);
    await sse.waitForEvent("snapshot");
    identity.observeCliUserAgent("codex", "codex-cli/1.2.3");
    const extracted = await sse.waitForEvent("snapshot");
    expect(extracted).toMatchObject({ health: { client_identity: {
      codex: { extracted: { user_agent: "codex-cli/1.2.3" } }
    } } });
    await sse.close();
  });
});
