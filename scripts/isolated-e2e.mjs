import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const keepAlive = process.argv.includes("--keep-alive");
const sourceServiceUrl = process.env.COMPACTGATE_SOURCE_URL ?? "http://127.0.0.1:7865";
const iceProfileName = process.env.COMPACTGATE_E2E_PROFILE ?? "冰";

const runtimeRoot = path.join(projectRoot, ".tmp", "isolated-e2e");
await mkdir(runtimeRoot, { recursive: true });
const runtimeDir = await mkdtemp(path.join(runtimeRoot, "run-"));
const tempConfigPath = path.join(runtimeDir, "compactgate.json");
const tempLogDbPath = path.join(runtimeDir, "compactgate-logs.sqlite");
const port = await findFreePort();
const listen = `127.0.0.1:${port}`;
let child = null;

try {
  const sourceConfigPath = await resolveSourceConfigPath();
  const sourceConfig = JSON.parse(await readFile(sourceConfigPath, "utf8"));
  const { config, copiedProfile } = buildIsolatedConfig(sourceConfig, listen);

  await writeFile(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  child = startServer(tempConfigPath, tempLogDbPath);
  await waitForHealth(`http://${listen}`);
  const summary = await validateRuntime(`http://${listen}`, copiedProfile);

  const result = {
    ok: true,
    url: `http://${listen}`,
    config_path: tempConfigPath,
    copied_profile: copiedProfile.name,
    checks: summary
  };
  console.log(JSON.stringify(result, null, 2));

  if (keepAlive) {
    await waitForShutdown();
  }
} finally {
  if (child) {
    await stopServer(child);
  }
  if (!keepAlive) {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

async function resolveSourceConfigPath() {
  if (process.env.COMPACTGATE_SOURCE_CONFIG) {
    return path.resolve(process.env.COMPACTGATE_SOURCE_CONFIG);
  }

  try {
    const response = await fetchWithTimeout(`${sourceServiceUrl}/api/config`, {}, 1500);
    if (response.ok) {
      const body = await response.json();
      if (typeof body.config_path === "string" && body.config_path.trim()) {
        return body.config_path;
      }
    }
  } catch {
    // Fall back to the default local config file below.
  }

  return path.join(projectRoot, "compactgate.json");
}

function buildIsolatedConfig(sourceConfig, nextListen) {
  const config = structuredClone(sourceConfig);
  const codexScope = config.profile_scopes?.codex;
  const profiles = Array.isArray(codexScope?.profiles) ? codexScope.profiles : [];
  const sourceProfile =
    profiles.find((profile) => profile?.name === iceProfileName) ??
    profiles.find((profile) => typeof profile?.name === "string" && profile.name.includes(iceProfileName));

  if (!sourceProfile) {
    throw new Error(`No Codex profile containing "${iceProfileName}" was found in source config.`);
  }

  const iso = new Date().toISOString();
  const copiedProfile = {
    ...structuredClone(sourceProfile),
    id: `${sourceProfile.id}-isolated-${Date.now().toString(36)}`,
    name: `${sourceProfile.name}-isolated-e2e`,
    created_at: iso,
    updated_at: iso
  };

  config.listen = nextListen;
  config.profile_scopes = {
    ...(config.profile_scopes ?? {}),
    codex: {
      profiles: [
        ...profiles.map((profile) => structuredClone(profile)),
        copiedProfile
      ],
      active_profile_id: copiedProfile.id
    }
  };
  config.active_profile_id = copiedProfile.id;

  if (copiedProfile.config?.primary) {
    config.primary = structuredClone(copiedProfile.config.primary);
  }
  if (copiedProfile.config?.compact) {
    config.compact = structuredClone(copiedProfile.config.compact);
  }
  config.logging = {
    ...(config.logging ?? {}),
    keep_recent: Math.min(Math.max(Number(config.logging?.keep_recent ?? 100), 20), 200)
  };

  return { config, copiedProfile };
}

function startServer(configPath, logDbPath) {
  const mainPath = path.join(projectRoot, "dist", "server", "main.js");
  const nextChild = spawn(process.execPath, [mainPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
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
    if (child?.exitCode !== null) {
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
  assertEqual(health.status, "ok", "health.status");
  assertEqual(health.listen, new URL(baseUrl).host, "health.listen");
  checks.push("health");

  const publicConfig = await expectJson(`${baseUrl}/api/config`);
  assertEqual(publicConfig.config_path, tempConfigPath, "config.config_path");
  assertEqual(publicConfig.listen, new URL(baseUrl).host, "config.listen");
  assertEqual(publicConfig.profile_scopes?.codex?.active_profile_id, copiedProfile.id, "codex.active_profile_id");
  if (!publicConfig.profile_scopes?.codex?.profiles?.some((profile) => profile.id === copiedProfile.id)) {
    throw new Error("Copied ice profile is missing from public config.");
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
  assertEqual(compactPreview.route, "compact", "compact preview route");
  checks.push("compact-route-preview");

  const primaryPreview = await postJson(`${baseUrl}/api/test-route`, {
    method: "POST",
    path: "/v1/responses",
    body: { model: "gpt-5.5", stream: true }
  });
  assertEqual(primaryPreview.route, "primary", "primary preview route");
  checks.push("primary-route-preview");

  const snapshot = await readFirstSseEvent(`${baseUrl}/api/events`);
  assertEqual(snapshot.event, "snapshot", "first SSE event");
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`${url} returned HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    return parseSseFrame(buffer.split(/\r?\n\r?\n/)[0] ?? "");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
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

  serverProcess.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => serverProcess.once("exit", resolve)),
    delay(2500).then(() => {
      if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
        serverProcess.kill("SIGKILL");
      }
    })
  ]);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
