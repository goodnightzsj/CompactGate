import { strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = path.resolve(import.meta.dirname, "..");
const keepAlive = process.argv.includes("--keep-alive");
const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-isolated-e2e-"));
const buildDir = path.join(runtimeDir, "build");
const tempConfigPath = path.join(runtimeDir, "compactgate.json");
const tempLogDbPath = path.join(runtimeDir, "compactgate-logs.sqlite");
const port = await findFreePort();
const listen = `127.0.0.1:${port}`;
let child = null;

try {
  await buildIsolatedArtifacts();
  const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(buildDir, "dist/server/config-defaults.js")).href);
  const { config, copiedProfile } = buildIsolatedConfig(DEFAULT_CONFIG, listen);

  await writeFile(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const { ClientIdentityStore, resolveClientIdentityStatePath } = await import(pathToFileURL(path.join(buildDir, "dist/server/client-identity-store.js")).href);
  const identity = new ClientIdentityStore({ statePath: resolveClientIdentityStatePath(tempConfigPath) });
  await identity.update({ enabled: false, codex: { version_tracked_user_agent: "codex-cli/0.0.0" },
    claude: { version_tracked_user_agent: "claude-cli/0.0.0" } });
  identity.close();
  await identity.flush();
  child = startServer(tempConfigPath, tempLogDbPath);
  await waitForHealth(`http://${listen}`);
  const summary = await validateRuntime(`http://${listen}`, copiedProfile);

  const result = {
    ok: true,
    url: `http://${listen}`,
    config_path: tempConfigPath,
    fixture_profile: copiedProfile.name,
    data_source: "synthetic",
    checks: summary
  };
  console.log(JSON.stringify(result, null, 2));

  if (keepAlive) {
    await waitForShutdown();
  }
} finally {
  try {
    if (child) await stopServer(child);
  } finally {
    if (!keepAlive) await rm(runtimeDir, { recursive: true, force: true });
  }
}

async function buildIsolatedArtifacts() {
  await mkdir(buildDir);
  for (const name of ["src", "public", "index.html", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.server.json", "vite.config.ts", "node_modules"]) {
    await cp(path.join(projectRoot, name), path.join(buildDir, name), { recursive: true, mode: constants.COPYFILE_FICLONE });
  }
  const build = spawn("npm", ["run", "build"], { cwd: buildDir,
    env: { PATH: process.env.PATH, TMPDIR: runtimeDir, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  build.stdout.pipe(process.stderr);
  build.stderr.pipe(process.stderr);
  await new Promise((resolve, reject) => {
    build.once("error", reject);
    build.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Isolated build failed (${code ?? signal}).`)));
  });
}

function buildIsolatedConfig(defaults, nextListen) {
  const config = structuredClone(defaults);
  for (const route of [config.primary, config.compact, config.claude.primary, config.claude.compact]) {
    route.base_url = "http://127.0.0.1:1/v1";
    route.api_key = route.api_key_env = "";
  }
  const iso = new Date().toISOString();
  const copiedProfile = {
    id: "synthetic-isolated",
    name: "Synthetic isolated fixture",
    config: { primary: config.primary, compact: config.compact },
    created_at: iso,
    updated_at: iso
  };

  config.listen = nextListen;
  config.profile_scopes = {
    ...(config.profile_scopes ?? {}),
    codex: {
      profiles: [copiedProfile],
      active_profile_id: copiedProfile.id
    }
  };
  config.active_profile_id = copiedProfile.id;

  config.logging = {
    ...config.logging, keep_recent: 20, capture_dir: path.join(runtimeDir, "captures")
  };

  return { config, copiedProfile };
}

function startServer(configPath, logDbPath) {
  const mainPath = path.join(buildDir, "dist", "server", "main.js");
  const nextChild = spawn(process.execPath, [mainPath], {
    cwd: runtimeDir,
    env: {
      PATH: "",
      TMPDIR: runtimeDir,
      COMPACTGATE_CONFIG: configPath,
      COMPACTGATE_LOG_DB: logDbPath,
      NODE_ENV: "production"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  nextChild.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  nextChild.once("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`Isolated CompactGate exited with code ${code}.`);
      if (stderr.trim()) {
        console.error(stderr.trim());
      }
    } else if (signal && signal !== "SIGTERM") {
      console.error(`Isolated CompactGate exited with signal ${signal}.`);
    }
  });

  return nextChild;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error("Isolated CompactGate exited before becoming healthy.");
    }

    try {
      const response = await fetchWithTimeout(`${baseUrl}/api/health`, {}, 1000);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the deadline.
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for isolated CompactGate health endpoint.");
}

async function validateRuntime(baseUrl, copiedProfile) {
  const checks = [];

  const health = await expectJson(`${baseUrl}/api/health`);
  strictEqual(health.status, "ok", "health.status");
  strictEqual(health.listen, new URL(baseUrl).host, "health.listen");
  checks.push("health");

  const publicConfig = await expectJson(`${baseUrl}/api/config`);
  strictEqual(publicConfig.config_path, tempConfigPath, "config.config_path");
  strictEqual(publicConfig.listen, new URL(baseUrl).host, "config.listen");
  strictEqual(publicConfig.profile_scopes?.codex?.active_profile_id, copiedProfile.id, "codex.active_profile_id");
  if (!publicConfig.profile_scopes?.codex?.profiles?.some((profile) => profile.id === copiedProfile.id)) {
    throw new Error("Synthetic profile is missing from public config.");
  }
  checks.push("config");

  await expectHtml(`${baseUrl}/`);
  await expectHtml(`${baseUrl}/#routes`);
  await expectHtml(`${baseUrl}/#config`);
  await expectHtml(`${baseUrl}/#logs`);
  await expectHtml(`${baseUrl}/health`);
  checks.push("frontend-entrypoints");

  const logs = await expectJson(`${baseUrl}/api/logs/recent`);
  if (!Array.isArray(logs.logs)) {
    throw new Error("Recent logs response must include logs array.");
  }
  checks.push("logs-api");

  const compactPreview = await postJson(`${baseUrl}/api/test-route`, {
    method: "POST",
    path: "/v1/responses/compact",
    body: { model: "gpt-5.5", stream: true }
  });
  strictEqual(compactPreview.route, "compact", "compact preview route");
  checks.push("compact-route-preview");

  const primaryPreview = await postJson(`${baseUrl}/api/test-route`, {
    method: "POST",
    path: "/v1/responses",
    body: { model: "gpt-5.5", stream: true }
  });
  strictEqual(primaryPreview.route, "primary", "primary preview route");
  checks.push("primary-route-preview");

  const snapshot = await readFirstSseEvent(`${baseUrl}/api/events`);
  strictEqual(snapshot.event, "snapshot", "first SSE event");
  checks.push("studio-events");

  return checks;
}

async function expectJson(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function expectHtml(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  if (!text.includes("CompactGate") || !text.includes("root")) {
    throw new Error(`${url} did not return the CompactGate app shell.`);
  }
}

async function postJson(url, body) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function readFirstSseEvent(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!response.ok || !response.body) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n\n")) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return parseSseFrame(buffer.split(/\r?\n\r?\n/)[0] ?? "");
}

function parseSseFrame(frame) {
  let event = "message";
  const dataLines = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  return {
    event,
    payload: dataLines.length > 0 ? JSON.parse(dataLines.join("\n")) : null
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(new Error("Expected TCP server address."));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function stopServer(serverProcess) {
  if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => serverProcess.once("exit", (code, signal) => resolve({ code, signal })));
  serverProcess.kill("SIGTERM");
  const deadline = setTimeout(() => serverProcess.kill("SIGKILL"), 12_000);
  try {
    const { code, signal } = await exited;
    if (code !== 0) throw new Error(`Isolated server shutdown failed (${code ?? signal}).`);
  } finally { clearTimeout(deadline); }
}

function waitForShutdown() {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      // Keep the parent process alive while the isolated server is used by browser checks.
    }, 60_000);
    const done = () => {
      clearInterval(interval);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}
