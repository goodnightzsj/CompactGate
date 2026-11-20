import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { afterEach, expect, it, vi } from "vitest";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { captureRequest, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

async function startCodexApp(upstreamUrl: string, retentionHours = 0) {
  vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
    http.request(new URL(target.pathname + target.search, upstreamUrl), {
      ...options, agent: undefined, headers: { ...options.headers, host: target.host }
    }, callback)) as typeof https.request);
  const issuer = oauthTestProvider("openai-codex");
  const app = await startApp(undefined, undefined, {
    primary_failover: { auto_schedule: false, state_recovery_retention_hours: retentionHours }
  }, issuer);
  const account = await issuer.authorize(app.config.oauth);
  await app.config.saveOAuthProfile("codex", account, "Synthetic OAuth", "synthetic-model", app.config.revision);
  await app.config.applyProfile("codex", app.config.toPublicConfig().profile_scopes.codex.profiles[0].id);
  return app;
}

it.each([[false, false], [true, true], [false, true], [true, false]])(
  "preserves OAuth compact adaptation on repeated requests: %s then %s", async (firstStream, secondStream) => {
    let requests = 0;
    const item = { type: "compaction", encrypted_content: "synthetic-context" };
    const response = { id: "resp_synthetic", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 3 } };
    const upstream = await startUpstream(async (req, res) => {
      await captureRequest(req);
      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.done", response }
      ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    const app = await startCodexApp(upstream.url);
    for (const stream of [firstStream, secondStream]) {
      const result = await postJson(app.url, "/v1/responses/compact", { model: "synthetic-model", input: "hello", stream });
      const text = await result.text();
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toContain(stream ? "text/event-stream" : "application/json");
      if (stream) {
        expect(text).toContain("response.completed");
        expect(text).not.toContain("response.done");
      } else expect(JSON.parse(text)).toEqual(response);
      const log = await waitForLogEntry(app.url, entry => entry.request_id === result.headers.get("x-compactgate-request-id"));
      expect(log.stream_outcome).toBe("success");
      expect(log.output_tokens).toBe(3);
    }
    expect(requests).toBe(2);
  }
);

it("retains OAuth compact deduplication when the upstream JSON needs no conversion", async () => {
  let requests = 0;
  const response = { output: [{ type: "compaction", encrypted_content: "synthetic-context" }] };
  const upstream = await startUpstream(async (req, res) => {
    await captureRequest(req);
    requests += 1;
    writeJsonResponse(res, response);
  });
  const app = await startCodexApp(upstream.url);
  for (let index = 0; index < 2; index++) {
    const result = await postJson(app.url, "/v1/responses/compact", { model: "synthetic-model", input: "hello" });
    expect(await result.json()).toEqual(response);
    await waitForLogEntry(app.url, entry => entry.request_id === result.headers.get("x-compactgate-request-id"));
  }
  expect(requests).toBe(1);
});

it.each([
  ["response.done", false], ["response.done", true],
  ["response.completed", false], ["response.completed", true]
] as const)("recovers retained OAuth continuation after %s, stream=%s", async (terminal, stream) => {
  const requests: Record<string, unknown>[] = [];
  const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recorded eu-west-2." }] };
  const upstream = await startUpstream(async (req, res) => {
    const body = JSON.parse((await captureRequest(req)).body);
    requests.push(body);
    if (body.previous_response_id) {
      writeJsonResponse(res, { error: { type: "invalid_request_error", code: "previous_response_not_found", message: "Synthetic missing continuation" } }, 400);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: terminal, response: { id: "resp_synthetic", status: "completed", output: [answer] } })}\n\n`);
  });
  const app = await startCodexApp(upstream.url, 1);
  const headers = { "x-compactgate-session": "synthetic-checkpoint-session" };
  const first = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: "The region is eu-west-2.", stream }, headers);
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("Recorded eu-west-2.");
  const firstLog = await waitForLogEntry(app.url, entry => entry.request_id === first.headers.get("x-compactgate-request-id"));
  expect(firstLog.stream_outcome).toBe("success");
  const next = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: "Which region?", previous_response_id: "resp_synthetic", stream }, headers);
  expect(next.status).toBe(200);
  expect(await next.text()).toContain("Recorded eu-west-2.");
  expect(requests).toHaveLength(3);
  expect(requests[2]).not.toHaveProperty("previous_response_id");
  expect(requests[2].input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "The region is eu-west-2." }] },
    answer, { type: "message", role: "user", content: [{ type: "input_text", text: "Which region?" }] }
  ]);
});

it.each([false, true])("recovers retained OAuth compact history, stream=%s", async stream => {
  const requests: Record<string, unknown>[] = [];
  const state = { type: "compaction", encrypted_content: "synthetic-opaque-state" };
  const upstream = await startUpstream(async (req, res) => {
    const body = JSON.parse((await captureRequest(req)).body);
    requests.push(body);
    if (!req.url?.endsWith("/compact") && JSON.stringify(body.input).includes(state.encrypted_content)) {
      writeJsonResponse(res, { error: { code: "invalid_encrypted_content", message: "The encrypted content could not be verified." } }, 400);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.done", response: {
      id: "resp_synthetic", status: "completed", output: req.url?.endsWith("/compact") ? [state] : []
    } })}\n\n`);
  });
  const app = await startCodexApp(upstream.url, 1);
  const headers = { "x-compactgate-session": "synthetic-compact-session" };
  const first = await postJson(app.url, "/v1/responses/compact", { model: "synthetic-model", input: "Remember the region eu-west-2.", stream }, headers);
  expect(first.status).toBe(200);
  await first.text();
  await waitForLogEntry(app.url, entry => entry.request_id === first.headers.get("x-compactgate-request-id"));
  const question = { type: "message", role: "user", content: [{ type: "input_text", text: "Which region?" }] };
  const next = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: [state, question], stream }, headers);
  expect(next.status).toBe(200);
  await next.text();
  expect(requests).toHaveLength(3);
  expect(requests[2].input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "Remember the region eu-west-2." }] }, question
  ]);
});

it.each(["missing-item", "contradictory-item"])("does not checkpoint a JSON-adapted stream with %s", async scenario => {
  const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Synthetic answer" }] };
  let requests = 0;
  const upstream = await startUpstream(async (req, res) => {
    requests += 1;
    const body = JSON.parse((await captureRequest(req)).body);
    if (body.previous_response_id) {
      writeJsonResponse(res, { error: { code: "previous_response_not_found", message: "Synthetic missing continuation" } }, 400);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "response.output_item.added", output_index: 0, item },
      ...(scenario === "contradictory-item" ? [{ type: "response.output_item.done", output_index: 0, item }] : []),
      { type: "response.done", response: { id: "resp_missing", status: "completed", output: scenario === "missing-item" ? [] : [{ ...item, role: "user" }] } }
    ];
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const app = await startCodexApp(upstream.url, 1);
  const headers = { "x-compactgate-session": "incomplete-synthetic" };
  const response = await postJson(app.url, "/v1/responses", {
    model: "synthetic-model", input: "Synthetic history", stream: false
  }, headers);
  expect(response.status).toBe(200);
  await response.text();
  await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
  const next = await postJson(app.url, "/v1/responses", {
    model: "synthetic-model", input: "Continue", previous_response_id: "resp_missing"
  }, headers);
  expect(next.status).toBe(400);
  expect(await next.text()).toContain("previous_response_not_found");
  expect(requests).toBe(2);
});
