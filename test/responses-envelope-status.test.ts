import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

describe("Responses completed event preserves the envelope failure", () => {
  it.each(["completed", "failed", "incomplete", "error"])("classifies %s consistently in JSON and SSE", async variant => {
    for (const stream of [false, true]) {
      const envelope = { id: "resp_synthetic_status", object: "response", status: variant === "error" ? "completed" : variant,
        output: [], ...(variant === "error" ? { error: { message: "Synthetic failure", code: "server_error" } } : {}) };
      const upstream = await startUpstream(async (req, res) => {
        await captureBody(req);
        res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
        res.end(stream ? `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: envelope })}\n\n` : JSON.stringify(envelope));
      });
      const app = await startApp(upstream.url, upstream.url);
      const response = await postJson(app.url, "/v1/responses", { model: "synthetic", input: "hello", stream });
      await response.text();
      const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
      const db = new DatabaseSync(path.join(app.dir, "compactgate-logs.sqlite"), { readOnly: true });
      let healthy: number;
      try { healthy = Number(db.prepare("SELECT count(*) AS n FROM provider_state_recovery_evidence WHERE evidence_kind = 'target_health'").get()?.n); }
      finally { db.close(); }
      expect({ outcome: log.stream_outcome, healthy }, `stream=${stream}`).toEqual({
        outcome: variant === "completed" ? "success" : "upstream_stream_incomplete", healthy: variant === "completed" ? 1 : 0
      });
    }
  });

  it.each(["completed", "failed", "incomplete", "error"])("does not deduplicate a compact %s envelope", async variant => {
    let attempts = 0;
    const envelope = { id: "resp_synthetic_compact", object: "response.compaction", status: variant === "error" ? "completed" : variant,
      output: [{ type: "compaction", encrypted_content: "synthetic_opaque_state" }],
      ...(variant === "error" ? { error: { message: "Synthetic failure", code: "server_error" } } : {}) };
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      attempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: envelope })}\n\n`);
    });
    const app = await startApp(upstream.url, upstream.url, { compact: { upstream_mode: "split" } });
    const body = { model: "synthetic", input: "hello" };
    await (await postJson(app.url, "/v1/responses/compact", body)).text();
    const log = await waitForLogEntry(app.url, () => true);
    await (await postJson(app.url, "/v1/responses/compact", body)).text();
    expect({ attempts, outcome: log.stream_outcome }).toEqual({ attempts: variant === "completed" ? 1 : 2,
      outcome: variant === "completed" ? "success" : "upstream_stream_incomplete" });
  });
});
