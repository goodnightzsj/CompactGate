import http, { type IncomingMessage, type RequestOptions, type ServerResponse } from "node:http";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logStatusKind } from "../src/ui/logs/log-utils.js";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import {
  captureBody, fetchLogPage, postJson, startApp, startUpstream, waitForLogEntry
} from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

const manual = { api_key: "", api_key_env: "" };
const usage = { input_tokens: 9, output_tokens: 2, total_tokens: 11 };

function writeSse(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

describe("observed response stream classification", () => {
  it("keeps the outcome consistent with a missing-SSE diagnostic", async () => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/html" }).end("synthetic non-stream response");
    });
    const app = await startApp(upstream.url, upstream.url, { primary: manual, compact: manual });
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: "synthetic", stream: true });
    await response.text();
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log).toMatchObject({ status: 200, stream_outcome: "upstream_stream_incomplete", error_summary: "OpenAI stream response was not text/event-stream." });
  });

  it.each([true, false, undefined])("fails over token-bearing SSE failures when request stream is %s", async (stream) => {
    let firstRequests = 0;
    let secondRequests = 0;
    const first = await startUpstream(async (req, res) => {
      await captureBody(req);
      firstRequests += 1;
      writeSse(res, [{ type: "response.failed", response: { usage } }]);
    });
    const second = await startUpstream(async (req, res) => {
      await captureBody(req);
      secondRequests += 1;
      writeSse(res, [{ type: "response.completed", response: { id: "synthetic-recovered", usage } }]);
    });
    const app = await startApp(first.url, first.url, {
      primary: manual, compact: manual, claude: { primary: manual, compact: manual }
    });
    await app.config.saveProfile("codex", "Failed", { primary: { ...manual, base_url: first.url } });
    await app.config.saveProfile("codex", "Healthy", { primary: { ...manual, base_url: second.url } });
    const profile = app.config.toPublicConfig().profile_scopes.codex.profiles.find((item) => item.name === "Failed")!;
    await app.config.applyProfile("codex", profile.id);
    const body = { model: "synthetic-model", input: "synthetic", ...(stream === undefined ? {} : { stream }) };
    let lastRequestId: string | null = null;
    for (let index = 0; index < 11; index += 1) {
      const response = await postJson(app.url, "/v1/responses", body);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("response.failed");
      lastRequestId = response.headers.get("x-compactgate-request-id");
    }
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === lastRequestId);
    expect(log).toMatchObject({
      status: 200, request_type: "stream", stream_terminal_event: "response.failed",
      stream_outcome: "upstream_stream_incomplete", total_tokens: 11,
      error_summary: "OpenAI stream ended with response.failed."
    });
    expect(logStatusKind(log)).toBe("error");
    expect((await fetchLogPage(app.url)).status_counts).toEqual({ all: 11, normal: 0, error: 11 });
    expect(firstRequests).toBe(11);
    expect(secondRequests).toBe(0);
    const recovered = await postJson(app.url, "/v1/responses", body);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain("synthetic-recovered");
    expect(firstRequests).toBe(11);
    expect(secondRequests).toBe(1);
  });

  it.each([false, undefined])("records an actual Claude SSE error when request stream is %s", async (stream) => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      writeSse(res, [
        { type: "message_start", message: { id: "synthetic-message", model: "synthetic-model", usage: { input_tokens: 9 } } },
        { type: "error", error: { type: "overloaded_error", message: "Synthetic stream failure" } }
      ]);
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary: manual, compact: manual,
      claude: { primary: { ...manual, base_url: upstream.url }, compact: manual }
    });
    const response = await postJson(app.url, "/anthropic/v1/messages", {
      model: "synthetic-model", max_tokens: 30, messages: [{ role: "user", content: "synthetic" }],
      ...(stream === undefined ? {} : { stream })
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Synthetic stream failure");
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log).toMatchObject({ status: 200, request_type: "stream", stream_outcome: "upstream_stream_error" });
    expect(log.error_summary).toContain("Synthetic stream failure");
    expect(logStatusKind(log)).toBe("error");
  });

  it.each([true, false].flatMap((stream) => ["completed", "failed", "incomplete"].map((status) => ({ stream, status }))))(
    "classifies Codex Local compaction $status with request stream $stream", async ({ stream, status }) => {
    const issuer = oauthTestProvider("openai-codex");
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse(await captureBody(req));
      expect(req.url).toBe("/backend-api/codex/responses");
      expect(body.stream).toBe(true);
      writeSse(res, [{
        type: status === "completed" ? "response.done" : `response.${status}`, response: {
          id: "synthetic-summary", model: "synthetic-model", status, usage,
          output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic summary" }] }]
        }
      }]);
    });
    vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => {
      if (!(target instanceof URL)) throw new Error("Unexpected synthetic OAuth HTTPS request signature.");
      return http.request(new URL(target.pathname + target.search, upstream.url), {
        ...options, agent: undefined, headers: { ...options.headers, host: target.host }
      }, callback);
    }) as typeof https.request);
    const app = await startApp(undefined, undefined, {
      primary: manual, compact: manual, claude: { primary: manual, compact: manual },
      primary_failover: { auto_schedule: false }
    }, issuer);
    const id = await issuer.authorize(app.config.oauth);
    await app.config.saveOAuthProfile("codex", id, "Codex", "synthetic-model", app.config.revision);
    await app.config.applyProfile("codex", app.config.toPublicConfig().profile_scopes.codex.profiles[0].id);
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: "synthetic", stream }, {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(stream ? "text/event-stream" : "application/json");
    expect(await response.text()).toContain("Synthetic summary");
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log).toMatchObject({ route: "compact", compaction_mode: "local", status: 200,
      stream_outcome: status === "completed" ? "success" : "upstream_stream_incomplete",
      error_summary: status === "completed" ? null : expect.any(String) });
    expect(logStatusKind(log)).toBe(status === "completed" ? "normal" : "error");
  });
});
