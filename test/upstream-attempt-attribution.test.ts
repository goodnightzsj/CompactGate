import { afterEach, describe, expect, it, vi } from "vitest";
import * as httpUtils from "../src/server/http-utils.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());
const apiKeys = ["a", "b"].map((id) => ({ id, label: id, api_key: `synthetic-${id}`, enabled: true }));

describe("upstream attempt ownership", () => {
  it.each(["primary", "compact"] as const)("keeps a real %s attempt when the retry budget is exhausted", async (route) => {
    let calls = 0;
    let elapsed = 0;
    const now = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
    const upstream = await startUpstream(async (req, res) => {
      calls++;
      await captureBody(req);
      elapsed = 1500;
      res.setHeader("retry-after", "0");
      writeJsonResponse(res, { error: "upstream_stream_error" }, 503);
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary: { api_key: "synthetic", api_key_env: "" }, compact: { upstream_mode: "primary" },
      timeouts: { primary_ms: 1000, compact_ms: 1000 }, primary_failover: { auto_schedule: false }
    });
    await app.config.saveProfile("codex", "Synthetic", {});
    await app.config.applyProfile("codex", app.config.get().profile_scopes!.codex!.profiles![0].id);
    const results = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");
    const activity = vi.spyOn(StudioEventBroadcaster.prototype, "broadcastKeyActivity");
    const response = await postJson(app.url, route === "compact" ? "/v1/responses/compact" : "/v1/responses", {
      model: "synthetic", input: "synthetic", stream: true
    });
    expect(response.status).toBe(502);
    await response.text();
    await waitForLogEntry(app.url, (entry) => entry.stream_outcome === "timeout");
    expect(calls).toBe(1);
    expect(results.mock.calls[0]?.[1]).toMatchObject({ status: 502, streamOutcome: "timeout" });
    expect(activity).toHaveBeenCalledTimes(1);
  });

  it.each(["primary", "compact", "claude"] as const)("does not charge %s health for a locally exhausted deadline", async (route) => {
    let calls = 0;
    const upstream = await startUpstream(async (req, res) => {
      calls++;
      await captureBody(req);
      writeJsonResponse(res, { output: [] });
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary: { api_key: "synthetic", api_key_env: "" },
      compact: { upstream_mode: "primary" },
      claude: { primary: { base_url: upstream.url, api_key: "synthetic", api_key_env: "", api_keys: apiKeys } },
      timeouts: { primary_ms: 1000, compact_ms: 1000, claude_ms: 1000 },
      primary_failover: { auto_schedule: false }
    });
    const scope = route === "claude" ? "claude" : "codex";
    await app.config.saveProfile(scope, "Synthetic", {});
    const profile = app.config.get().profile_scopes![scope]!.profiles![0];
    await app.config.applyProfile(scope, profile.id);
    const primaryResults = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");
    const claudeResults = vi.spyOn(ClaudeKeyPoolState.prototype, "recordResult");
    const activity = vi.spyOn(StudioEventBroadcaster.prototype, "broadcastKeyActivity");
    const now = performance.now.bind(performance);
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
    const read = httpUtils.readRawBody;
    vi.spyOn(httpUtils, "readRawBody").mockImplementation(async (...args) => {
      const body = await read(...args);
      elapsed = 1500;
      return body;
    });
    const endpoint = route === "claude" ? "/anthropic/v1/messages" : route === "compact" ? "/v1/responses/compact" : "/v1/responses";
    const response = await postJson(app.url, endpoint, {
      model: "synthetic", input: "synthetic", messages: [{ role: "user", content: "synthetic" }], max_tokens: 8
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toHaveProperty("error", expect.stringContaining("timed out"));
    await waitForLogEntry(app.url, (entry) => entry.stream_outcome === "timeout");
    expect(calls).toBe(0);
    const results = route === "claude" ? claudeResults : primaryResults;
    expect(results).toHaveBeenCalledTimes(1);
    expect(results.mock.calls[0]?.[0]).not.toBeNull();
    expect(results.mock.calls[0]?.[1]).toBeNull();
    expect(activity).not.toHaveBeenCalled();
  });

  it.each(["primary", "compact", "claude"] as const)("still charges %s for a real connection failure without HTTP headers", async (route) => {
    let calls = 0;
    const upstream = await startUpstream((req) => { calls++; req.socket.destroy(); });
    const app = await startApp(upstream.url, upstream.url, {
      primary: { api_key: "synthetic", api_key_env: "" }, compact: { upstream_mode: "primary" },
      claude: { primary: { base_url: upstream.url, api_key: "synthetic", api_key_env: "", api_keys: apiKeys } },
      primary_failover: { auto_schedule: false }
    });
    const scope = route === "claude" ? "claude" : "codex";
    await app.config.saveProfile(scope, "Synthetic", {});
    await app.config.applyProfile(scope, app.config.get().profile_scopes![scope]!.profiles![0].id);
    const primaryResults = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");
    const claudeResults = vi.spyOn(ClaudeKeyPoolState.prototype, "recordResult");
    const endpoint = route === "claude" ? "/anthropic/v1/messages" : route === "compact" ? "/v1/responses/compact" : "/v1/responses";
    const response = await postJson(app.url, endpoint, {
      model: "synthetic", input: "synthetic", messages: [{ role: "user", content: "synthetic" }], max_tokens: 8
    });
    expect(response.status).toBe(502);
    await response.text();
    await waitForLogEntry(app.url, (entry) => entry.stream_outcome === "upstream_request_error");
    expect(calls).toBe(1);
    const results = route === "claude" ? claudeResults : primaryResults;
    expect(results.mock.calls[0]?.[1]).toMatchObject({ status: 502, streamOutcome: "upstream_request_error" });
  });
});
