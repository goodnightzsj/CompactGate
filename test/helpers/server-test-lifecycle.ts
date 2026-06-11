import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../../src/server/config.js";
import { createCompactGateServer } from "../../src/server/http.js";

export const cleanup: Array<() => Promise<void>> = [];
export const cleanupEnvKeys = new Set<string>();

export async function startApp(
  primaryBaseUrl?: string,
  compactBaseUrl?: string,
  patch?: Record<string, unknown>
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return startAppInDir(dir, primaryBaseUrl, compactBaseUrl, patch);
}

export async function startAppInDir(
  dir: string,
  primaryBaseUrl?: string,
  compactBaseUrl?: string,
  patch?: Record<string, unknown>
) {
  const primaryPatch = isRecord(patch?.primary) ? patch.primary : {};
  const compactPatch = isRecord(patch?.compact) ? patch.compact : {};
  const config = await ConfigStore.load(path.join(dir, "compactgate.json"));

  await config.patch({
    ...patch,
    primary: {
      base_url: primaryBaseUrl ?? "http://127.0.0.1:1/v1",
      ...primaryPatch
    },
    compact: {
      base_url: compactBaseUrl ?? "http://127.0.0.1:1/v1",
      ...compactPatch
    }
  });

  const server = createCompactGateServer(config);
  await listen(server);
  const closeServer = trackServer(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    dir,
    url: `http://127.0.0.1:${address.port}`,
    close: closeServer
  };
}

export function setEnv(key: string, value: string) {
  process.env[key] = value;
  cleanupEnvKeys.add(key);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function trackServer(server: Server): () => Promise<void> {
  let closed = false;

  const closeServer = async () => {
    if (closed) {
      return;
    }

    closed = true;
    await close(server);
  };

  cleanup.push(closeServer);
  return closeServer;
}

export function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
