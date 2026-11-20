import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

const requestBody = { model: "synthetic-model", input: [{ type: "message", role: "user", content: "Summarize the visible context." }] };
const goodOutput = [{ type: "compaction", encrypted_content: "synthetic-new-state" }];

describe("response business failure handling", () => {
  it.each(["json-failed", "sse-error"])("does not record ordinary Primary %s as healthy", async variant => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      if (variant === "json-failed") {
        writeJsonResponse(res, { id: "resp_synthetic_failed", status: "failed", error: { code: "server_error", message: "Synthetic failure" }, output: [] });
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: "Synthetic stream error", param: null, sequence_number: 1 })}\n\ndata: [DONE]\n\n`);
      }
    });
    const app = await startApp(upstream.url, upstream.url);
    const response = await postJson(app.url, "/v1/responses", { ...requestBody, stream: variant === "sse-error" }, { "x-compactgate-session": "synthetic-health-session" });
    await response.text();
    const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
    const db = new DatabaseSync(path.join(app.dir, "compactgate-logs.sqlite"), { readOnly: true });
    let health: number;
    try { health = Number(db.prepare("SELECT COUNT(*) AS count FROM provider_state_recovery_evidence WHERE evidence_kind = 'target_health'").get()?.count); }
    finally { db.close(); }
    expect(log.stream_outcome).not.toBe("success");
    expect(health).toBe(0);
  });

  it.each(["failed", "incomplete"])("does not cache HTTP 200 %s JSON", async status => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      attempts++;
      writeJsonResponse(res, attempts === 1
        ? { status, ...(status === "failed" ? { error: { code: "server_error", message: "Synthetic failure" } } : {}), output: [] }
        : { status: "completed", output: goodOutput });
    });
    const app = await startApp(upstream.url, upstream.url, { compact: { upstream_mode: "split" } });
    const first = await postJson(app.url, "/v1/responses/compact", requestBody);
    expect((await first.json()).status).toBe(status);
    const firstLog = await waitForLogEntry(app.url, () => true);
    const second = await postJson(app.url, "/v1/responses/compact", requestBody);
    const secondBody = await second.json();
    expect(attempts).toBe(2);
    expect(secondBody.status).toBe("completed");
    expect(firstLog.stream_outcome).not.toBe("success");
  });

  it("does not mistake a top-level SSE error followed by DONE for supported compaction", async () => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: goodOutput[0] })}\n\n`,
        `event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: "Synthetic stream error", param: null })}\n\n`,
        "data: [DONE]\n\n"
      ].join(""));
    });
    const app = await startApp(upstream.url, upstream.url);
    const result = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic-model" }).then(response => response.json());
    expect(result.supported).toBe(false);
  });

  it("does not cache a compact SSE error followed by DONE", async () => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      attempts++;
      if (attempts > 1) {
        writeJsonResponse(res, { status: "completed", output: goodOutput });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: goodOutput[0] })}\n\n`,
        `event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: "Synthetic stream error", param: null })}\n\n`,
        "data: [DONE]\n\n"
      ].join(""));
    });
    const app = await startApp(upstream.url, upstream.url, { compact: { upstream_mode: "split" } });
    const first = await postJson(app.url, "/v1/responses/compact", requestBody);
    const firstText = await first.text();
    const firstLog = await waitForLogEntry(app.url, () => true);
    const second = await postJson(app.url, "/v1/responses/compact", requestBody);
    const secondText = await second.text();
    expect(attempts).toBe(2);
    expect(secondText).not.toBe(firstText);
    expect(firstLog.stream_outcome).not.toBe("success");
  });

  it("still caches ordinary successful native JSON", async () => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      attempts++;
      writeJsonResponse(res, { output: goodOutput });
    });
    const app = await startApp(upstream.url, upstream.url, { compact: { upstream_mode: "split" } });
    await (await postJson(app.url, "/v1/responses/compact", requestBody)).text();
    await waitForLogEntry(app.url, () => true);
    await (await postJson(app.url, "/v1/responses/compact", requestBody)).text();
    expect(attempts).toBe(1);
  });
});
