import path from "node:path";
import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import type { CaptureRecord } from "../src/shared/types.js";
import { captureResponseDiff } from "../src/shared/capture-diff.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

it("marks a missing client capture unavailable when a committed converted stream fails", async () => {
  const dir = await makeConfigDir();
  let upstreamResponse: ServerResponse | undefined;
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    upstreamResponse = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "chat-synthetic", model: "fixture", choices: [
      { index: 0, delta: { role: "assistant", content: "visible output" }, finish_reason: null }
    ] })}\n\n`);
  });
  const app = await startApp(upstream.url, undefined, { primary: { upstream_protocol: "openai_chat" },
    logging: { capture_dir: path.join(dir, "captures") } });
  const response = await postJson(app.url, "/v1/responses", { model: "fixture", input: "synthetic", stream: true });
  const reader = response.body!.getReader();
  try {
    expect(response.status).toBe(200);
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    upstreamResponse!.destroy();
    try { while (!(await reader.read()).done) { /* Drain until the connection failure. */ } } catch { /* Expected upstream disconnect. */ }
    const entry = await waitForLogEntry(app.url, row => row.capture_status === "present");
    const capture: CaptureRecord = await fetch(`${app.url}/api/logs/${entry.request_id}/capture`).then(result => result.json());
    expect(capture.upstream_status).toBe(200);
    expect(capture.client_response).toBeNull();
    expect(captureResponseDiff(capture)).toMatchObject({ available: false, equivalent: false, reason: "unavailable" });
  } finally {
    upstreamResponse?.destroy();
    await reader.cancel().catch(() => undefined);
  }
});

it.each(["primary", "compact", "claude"])("captures the actual local %s error body, headers and status", async route => {
  const dir = await makeConfigDir();
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    if (route === "compact") { req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>synthetic non-API response</html>");
  });
  const app = await startApp(upstream.url, upstream.url, {
    logging: { capture_dir: path.join(dir, "captures") },
    claude: { primary: { base_url: upstream.url, upstream_protocol: "openai_responses" } }
  });
  const response = await postJson(app.url, route === "claude" ? "/anthropic/v1/messages" : route === "compact" ? "/v1/responses/compact" : "/v1/responses",
    route === "claude" ? { model: "fixture", max_tokens: 20, messages: [{ role: "user", content: "synthetic" }] }
      : { model: "fixture", input: "synthetic" });
  const actualBody = await response.text();
  expect(response.status).toBe(502);
  const requestId = JSON.parse(actualBody).request_id;
  await waitForLogEntry(app.url, row => row.request_id === requestId && row.capture_status === "present");
  const capture: CaptureRecord = await fetch(`${app.url}/api/logs/${requestId}/capture`).then(result => result.json());
  expect(capture.upstream_status).toBe(route === "compact" ? null : 200);
  expect(capture.client_response?.status).toBe(response.status);
  expect(capture.client_response?.headers["content-type"]).toBe(response.headers.get("content-type"));
  expect(capture.client_response?.body.text).toBe(actualBody);
  expect(captureResponseDiff(capture).equivalent).toBe(false);
});
