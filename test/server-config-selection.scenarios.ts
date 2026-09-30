import { promises as fs } from "node:fs";
import { request } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import * as httpUtils from "../src/server/http-utils.js";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import { injectFileCommitFault } from "./helpers/file-commit-fault.js";
import {
  captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse
} from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const keys = (first: string) => [
  { id: "a", label: "A", api_key: first, enabled: true },
  { id: "b", label: "B", api_key: "synthetic-b", enabled: true }
];

it.each(["primary", "compact", "local-compact", "explicit-primary", "claude"] as const)(
  "%s preserves config generation and quarantine across a slow request body",
  async (route) => {
    const observed: string[] = [];
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      const key = String(route === "claude" ? req.headers["x-api-key"] : req.headers.authorization);
      observed.push(key);
      if (key.endsWith("synthetic-new-a")) {
        writeJsonResponse(res, { error: { message: "Synthetic invalid credential" } }, 401);
      } else if (route === "claude") {
        writeJsonResponse(res, { id: "synthetic", type: "message", role: "assistant", model: "synthetic",
          content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      } else {
        writeJsonResponse(res, { id: "synthetic", status: "completed",
          output: route === "compact" ? [{ type: "compaction", encrypted_content: "synthetic" }] : [],
          output_text: "ok", usage: { input_tokens: 1, output_tokens: 1 } });
      }
    });
    const pool = { api_key: "", api_key_env: "", api_keys: keys("synthetic-old-a") };
    const app = await startApp(upstream.url, upstream.url, route === "claude"
      ? { claude: { primary: { ...pool, base_url: upstream.url } } }
      : { primary: pool, compact: { upstream_mode: "primary" } });
    const scope = route === "claude" ? "claude" : "codex";
    await app.config.saveProfile(scope, "Synthetic", {});
    const profileId = app.config.get().profile_scopes![scope]!.profiles![0].id;
    await app.config.applyProfile(scope, profileId);
    const pathname = route === "claude" ? "/anthropic/v1/messages"
      : route === "compact" ? "/v1/responses/compact" : "/v1/responses";
    let sequence = 0;
    const body = () => ({ model: "synthetic", input: `request-${sequence++}`,
      ...(route === "local-compact"
        ? { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) } }
        : {}),
      messages: [{ role: "user", content: "synthetic" }], max_tokens: 8 });
    const send = async () => {
      const response = await postJson(app.url, pathname, body());
      expect(response.headers.get("x-compactgate-route")).toBe(
        route === "compact" || route === "local-compact" ? "compact" : route === "claude" ? "claude" : "primary"
      );
      await response.text();
      await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
      return response.status;
    };
    expect(await send()).toBe(200);

    // Observe the real read boundary; do not replace the body or its timing.
    const entered = signal();
    const read = httpUtils.readRawBody;
    vi.spyOn(httpUtils, "readRawBody").mockImplementation((req, limit) => {
      const result = read(req, limit);
      if (req.headers["x-synthetic-slow"] === "yes") entered.resolve();
      return result;
    });
    const slow = request(`${app.url}${pathname}`, {
      method: "POST", headers: { "content-type": "application/json", "x-synthetic-slow": "yes",
        ...(route === "explicit-primary" ? { "x-compactgate-profile": profileId } : {}) }
    });
    const completed = new Promise<number | undefined>((resolve, reject) => {
      slow.on("error", reject);
      slow.on("response", (res) => {
        res.on("error", reject);
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
    });
    try {
      slow.write("{");
      await entered.promise;
      const changed = { api_keys: keys("synthetic-new-a") };
      await app.config.patch(route === "claude" ? { claude: { primary: changed } } : { primary: changed });
      expect(await send()).toBe(401);
      expect(await send()).toBe(200);
      expect(observed.at(-1)).toMatch(/synthetic-b$/);
      slow.end(JSON.stringify(body()).slice(1));
      expect(await completed).toBe(200);
      const slowKey = route === "explicit-primary" ? "synthetic-old-a" : "synthetic-b";
      expect(observed.at(-1)?.replace("Bearer ", "")).toBe(slowKey);
      expect(await send()).toBe(200);
      expect(observed.map((key) => key.replace("Bearer ", ""))).toEqual([
        "synthetic-old-a", "synthetic-new-a", "synthetic-b", slowKey, "synthetic-b"
      ]);
    } finally {
      slow.destroy();
      await completed.catch(() => undefined);
    }
  }
);

async function scheduledFixture() {
  const calls: string[] = [];
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    const key = String(req.headers.authorization);
    calls.push(key);
    writeJsonResponse(res, key.endsWith("synthetic-c")
      ? { id: "synthetic", status: "completed", output: [], output_text: "ok" }
      : { error: { message: "Synthetic invalid credential" } }, key.endsWith("synthetic-c") ? 200 : 401);
  });
  const app = await startApp(upstream.url, upstream.url);
  const ids: string[] = [];
  for (const name of ["a", "b", "c"]) {
    await app.config.saveProfile("codex", name, { primary: { api_key: `synthetic-${name}` } });
    ids.push(app.config.get().profile_scopes!.codex!.profiles!.find((profile) => profile.name === name)!.id);
  }
  await app.config.applyProfile("codex", ids[0]);
  const send = () => postJson(app.url, "/v1/responses", { model: "synthetic", input: "synthetic" });
  for (const id of ids.slice(0, 2)) {
    const response = await send();
    expect(response.status).toBe(401);
    await response.text();
    await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(app.config.get().profile_scopes!.codex!.active_profile_id).toBe(id);
  }
  return { app, ids, send, calls };
}

it("does not overwrite a queued manual choice or fail its proxy request when automatic sync is stale", async () => {
  const { app, ids, send, calls } = await scheduledFixture();
  const manualEntered = signal();
  const releaseManual = signal();
  const automaticQueued = signal();
  const configPath = app.config.getConfigPath();
  const rename = fs.rename;
  const commits: string[] = [];
  const snapshots = vi.spyOn(StudioEventBroadcaster.prototype, "broadcastSnapshot");
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === configPath) {
      const next = JSON.parse(await fs.readFile(from, "utf8"));
      commits.push(next.profile_scopes.codex.active_profile_id);
      if (commits.length === 1) {
        expect(commits[0]).toBe(ids[1]);
        manualEntered.resolve();
        await releaseManual.promise;
      }
    }
    return rename(from, to);
  });
  const apply = app.config.applyProfile.bind(app.config);
  vi.spyOn(app.config, "applyProfile").mockImplementation((...args) => {
    const result = apply(...args);
    if (args[1] === ids[2]) automaticQueued.resolve();
    return result;
  });
  const manual = postJson(app.url, "/api/config/profiles/apply", { scope: "codex", profile_id: ids[1] });
  let automatic: ReturnType<typeof send> | undefined;
  try {
    await manualEntered.promise;
    automatic = send();
    await automaticQueued.promise;
    releaseManual.resolve();
    const manualResult = await manual;
    expect(manualResult.status).toBe(200);
    await manualResult.text();
    const proxyResult = await automatic;
    expect(proxyResult.status).toBe(200);
    await proxyResult.text();
    expect(calls.at(-1)).toBe("Bearer synthetic-c");
    expect(app.config.get().profile_scopes!.codex!.active_profile_id).toBe(ids[1]);
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).profile_scopes.codex.active_profile_id).toBe(ids[1]);
    expect(commits).toEqual([ids[1]]);
    expect(snapshots.mock.calls.every(([snapshot]) => snapshot.config.profile_scopes.codex.active_profile_id !== ids[2])).toBe(true);
  } finally {
    releaseManual.resolve();
    await Promise.allSettled([manual, automatic]);
  }
});

it("still synchronizes an automatic choice when no newer configuration intervenes", async () => {
  const { app, ids, send } = await scheduledFixture();
  const response = await send();
  expect(response.status).toBe(200);
  await response.text();
  expect(app.config.get().profile_scopes!.codex!.active_profile_id).toBe(ids[2]);
});

it.each(["file-sync", "directory-sync"] as const)("preserves automatic sync %s failures", async (stage) => {
  const { app, ids, send, calls } = await scheduledFixture();
  injectFileCommitFault(app.config.getConfigPath(), stage);
  const response = await send();
  expect(response.status).toBe(stage === "directory-sync" ? 500 : 502);
  await response.text();
  expect(calls).toHaveLength(2);
  expect(app.config.get().profile_scopes!.codex!.active_profile_id).toBe(stage === "directory-sync" ? ids[2] : ids[1]);
});
