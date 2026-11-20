import { setTimeout as delay } from "node:timers/promises";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

it.each(["normal", "timeout", "disconnect"].flatMap(reason => ["/v1/responses", "/v1/responses/compact"].map(route => ({ reason, route }))))(
  "automatic profile persistence finishes safely after $reason (route=$route)", async ({ reason, route }) => {
  const slow = reason !== "normal";
  const used: string[] = [];
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    const key = String(req.headers.authorization);
    used.push(key);
    writeJsonResponse(res, key === "Bearer synthetic-a" ? { error: "Invalid API key" }
      : { id: "resp_ok", status: "completed", output: [] }, key === "Bearer synthetic-a" ? 401 : 200);
  });
  const primary = { ...DEFAULT_CONFIG.primary, base_url: upstream.url, api_key_env: "", api_key: "synthetic-a" };
  const compact = { ...DEFAULT_CONFIG.compact, upstream_mode: "primary" };
  const app = await startApp(upstream.url, undefined, {
    primary, compact, timeouts: { primary_ms: reason === "timeout" ? 80 : 5000, compact_ms: reason === "timeout" ? 80 : 5000 },
    primary_failover: { auto_schedule: true },
    profile_scopes: { codex: { active_profile_id: "a", profiles: [
      { id: "a", name: "A", config: { primary, compact } },
      { id: "b", name: "B", config: { primary: { ...primary, api_key: "synthetic-b" }, compact } }
    ] } }
  });
  const first = await postJson(app.url, "/v1/responses", { model: "fixture", input: "hi" });
  expect(first.status).toBe(401);
  await first.text();
  await waitForLogEntry(app.url, entry => entry.request_id === first.headers.get("x-compactgate-request-id"));
  const commits = vi.spyOn(app.config, "applyProfile");
  const results = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");

  const open = fs.open;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const [file, flags] = args;
    if (typeof file === "string" && path.dirname(file) === app.dir &&
      path.basename(file).startsWith(".compactgate.json.") && flags === "wx") {
      enter();
      if (slow) await gate;
    }
    return open(...args);
  });
  const controller = new AbortController();
  let settled = false;
  const second = fetch(`${app.url}${route}`, { method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", input: "hi" }) })
    .then(async response => { await response.text(); settled = true; return response.status; })
    .catch(error => { if (!controller.signal.aborted) throw error; return 0; });
  let settledByDeadline = false;
  let releasedBeforeCommit = false;
  try {
    await entered;
    if (reason === "disconnect") controller.abort();
    await delay(240);
    settledByDeadline = settled;
    releasedBeforeCommit = results.mock.calls.some(([, result]) => result === null);
  } finally { release(); }
  const status = await second;
  await commits.mock.results[0].value;
  expect(app.config.get().profile_scopes?.codex?.active_profile_id).toBe("b");
  expect(JSON.parse(await fs.readFile(app.config.getConfigPath(), "utf8")).profile_scopes.codex.active_profile_id).toBe("b");
  expect(status).toBe(reason === "disconnect" ? 0 : slow ? 502 : 200);
  expect(used).toEqual(slow ? ["Bearer synthetic-a"] : ["Bearer synthetic-a", "Bearer synthetic-b"]);
  if (reason !== "disconnect") expect(settledByDeadline).toBe(true);
  expect(releasedBeforeCommit).toBe(slow);
});
