import http, { type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { ClientIdentityStore } from "../src/server/client-identity-store.js";
import { CodexVersionMonitor } from "../src/server/codex-version.js";
import { CompactionBridgeStore } from "../src/server/compaction-bridge.js";
import { DebugCaptureWriter } from "../src/server/debug-capture.js";
import { RequestLogger } from "../src/server/logger.js";
import { proxyOpenAiRequest } from "../src/server/openai-proxy.js";
import { classifyPrimaryRouteResult, PrimaryFailoverState } from "../src/server/primary-failover.js";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import { sendBufferedUpstreamRequest, UpstreamRequestError } from "../src/server/upstream-client.js";
import { listen, trackServer } from "./helpers/server-test-lifecycle.js";
import { captureBody, cleanup, postJson, startUpstream } from "./helpers/server-test-utils.js";

const clientError = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

async function proxyFixture(upstreamUrl: string, onResponse: (res: ServerResponse) => void) {
  vi.stubEnv("COMPACTGATE_CAPTURE_DIR", "");
  cleanup.push(async () => { vi.unstubAllEnvs(); });
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-client-error-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = await ConfigStore.load(path.join(dir, "config.json"));
  await config.patch({
    primary: { base_url: upstreamUrl, api_key: "synthetic", api_key_env: "" },
    compact: { upstream_mode: "primary" },
    timeouts: { primary_ms: 5_000, compact_ms: 5_000 },
    primary_failover: { auto_schedule: false },
    logging: { capture_dir: null }
  });
  await config.saveProfile("codex", "Synthetic", {});
  const profile = config.get().profile_scopes?.codex?.profiles?.[0];
  if (!profile) throw new Error("Missing synthetic profile.");
  await config.applyProfile("codex", profile.id);
  const logger = new RequestLogger(10, path.join(dir, "logs.sqlite"));
  const events = new StudioEventBroadcaster();
  const monitor = new CodexVersionMonitor({ probe: () => null });
  const identity = new ClientIdentityStore({ statePath: path.join(dir, "identity.json"), fetchLatestVersion: async () => null });
  const bridge = new CompactionBridgeStore();
  const capture = DebugCaptureWriter.fromConfig(null);
  const state = new PrimaryFailoverState();
  const results = vi.spyOn(state, "recordResult");
  cleanup.push(async () => {
    results.mockRestore();
    identity.close();
    await identity.flush();
    config.oauth.close();
    monitor.close();
    events.close();
    logger.close();
  });
  const requests: Promise<void>[] = [];
  const server = http.createServer((req, res) => {
    onResponse(res);
    requests.push(proxyOpenAiRequest(req, res, new URL(req.url ?? "/", "http://localhost"),
      config, logger, capture, bridge, events, state, monitor, identity));
  });
  await listen(server);
  trackServer(server);
  cleanup.push(async () => { await Promise.all(requests); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return { url: `http://127.0.0.1:${address.port}`, state, results, config, requests };
}

describe("client write failure attribution", () => {
  it.each(["/v1/responses", "/v1/responses/compact"])("keeps %s EPIPE neutral through the production result projection", async (endpoint) => {
    let clientResponse: ServerResponse | undefined;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      // Only this request's downstream response is faulted; no global prototype patch.
      clientResponse?.emit("error", clientError());
      res.end();
    });
    const app = await proxyFixture(upstream.url, (res) => { clientResponse = res; });
    const before = app.state.preview(app.config.get()).healthVersion;
    const response = await postJson(app.url, endpoint, { model: "synthetic", input: "synthetic", stream: true });
    expect(await response.json()).toMatchObject({ error: "write EPIPE" });
    await Promise.all(app.requests);
    expect(app.results).toHaveBeenCalledTimes(1);
    expect(app.results.mock.calls[0]![0].profileName).toBe("Synthetic");
    expect(app.results.mock.calls[0]![1]).toMatchObject({ streamOutcome: "client_cancel", errorSummary: "write EPIPE" });
    expect(app.state.preview(app.config.get()).healthVersion).toBe(before);
    const candidateId = app.results.mock.calls[0]![0].candidateId!;
    // Health has no public snapshot; inspect the owned record to verify load release too.
    expect(app.state["health"].get(candidateId)).toMatchObject({
      inFlight: 0, failures: 0, successes: 0, transientFailures: 0, cooldownUntil: 0, quarantineUntil: 0
    });
  });

  it("still charges an upstream HTTP error with the same EPIPE diagnostic", async () => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":{"message":"write EPIPE"}}');
    });
    const app = await proxyFixture(upstream.url, () => {});
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic", input: "synthetic", stream: false });
    expect(await response.text()).toContain("write EPIPE");
    await Promise.all(app.requests);
    const candidateId = app.results.mock.calls[0]![0].candidateId!;
    expect(app.results.mock.calls[0]![1]).toMatchObject({ errorSummary: expect.stringContaining("write EPIPE") });
    expect(app.state["health"].get(candidateId)).toMatchObject({ inFlight: 0, failures: 1, transientFailures: 1 });
  });

  it("uses explicit upstream attribution before legacy cancellation text", () => {
    const legacy = { status: 502, errorSummary: "Client disconnected before upstream response completed." };
    expect(classifyPrimaryRouteResult(legacy)).toBe("client_cancel");
    expect(classifyPrimaryRouteResult({ ...legacy, streamOutcome: "upstream_request_error" })).toBe("transient");
    expect(classifyPrimaryRouteResult({ status: 502, errorSummary: "write EPIPE", streamOutcome: "client_cancel" })).toBe("client_cancel");
  });

  it("retains the exact client Error as the native cause at the transport boundary", async () => {
    let clientResponse: ServerResponse | undefined;
    const original = clientError();
    const upstream = await startUpstream((_req, res) => {
      clientResponse?.emit("error", original);
      res.end();
    });
    let failure: unknown;
    const server = http.createServer(async (req, res) => {
      clientResponse = res;
      try {
        await sendBufferedUpstreamRequest({ req, res, upstream: new URL(upstream.url),
          startedAt: performance.now(), timeoutMs: 5_000, timeoutMessage: "Synthetic timeout",
          requestHeaders: {}, body: Buffer.alloc(0), extraResponseHeaders: {} });
      } catch (error) {
        failure = error;
        res.writeHead(502).end();
      }
    });
    await listen(server);
    trackServer(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    await response.text();
    expect(failure).toBeInstanceOf(UpstreamRequestError);
    expect(failure).toMatchObject({ details: { kind: "client_cancel" }, message: "write EPIPE" });
    expect((failure as UpstreamRequestError).cause).toBe(original);
  });

  it.each([
    [401, "invalid token", "upstream_http_error", "auth"],
    [200, "OpenAI stream ended with response.failed.", "upstream_stream_incomplete", "transient"],
    [200, null, "success", "success"]
  ] as const)("preserves terminal classification for status %s and outcome %s", (status, errorSummary, streamOutcome, expected) => {
    expect(classifyPrimaryRouteResult({ status, errorSummary, streamOutcome })).toBe(expected);
  });
});
