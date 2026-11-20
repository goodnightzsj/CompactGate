import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAnthropicToResponsesStream, createAnthropicToResponsesCompactionStream } from "../src/server/protocol-stream.js";
import { sseDataFrames } from "../src/server/sse-frames.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

function source(compact: boolean, fail: boolean, stop: boolean): string {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_synthetic", model: "synthetic", usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: compact
      ? { type: "compaction", content: "Synthetic summary" } : { type: "text", text: "Synthetic partial answer" } },
    { type: "content_block_stop", index: 0 }
  ];
  if (fail) events.push({ type: "error", error: { type: "overloaded_error", message: "Synthetic failure" } });
  if (stop) events.push({ type: "message_delta", delta: { stop_reason: compact ? "compaction" : "end_turn" }, usage: { output_tokens: 4 } }, { type: "message_stop" });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe.each([false, true])("Anthropic translated terminal compact=%s", compact => {
  it.each([
    ["normal", false, true], ["error only", true, false], ["error followed by stop", true, true]
  ] as const)("preserves the result for %s", async (_label, fail, stop) => {
    const transform = compact ? createAnthropicToResponsesCompactionStream() : createAnthropicToResponsesStream();
    Readable.from([source(compact, fail, stop)]).pipe(transform);
    const chunks: Buffer[] = [];
    for await (const chunk of transform) chunks.push(Buffer.from(chunk));
    const events = sseDataFrames(Buffer.concat(chunks).toString()).map(data => JSON.parse(data));
    if (fail) expect(events.at(-1)?.type).toBe("response.failed");
    expect(events.filter(event => event.type === "response.failed")).toHaveLength(fail ? 1 : 0);
    expect(events.filter(event => event.type === "response.completed")).toHaveLength(fail ? 0 : 1);
  });

  it("HTTP keeps the failed source from announcing a successful client result", async () => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(source(compact, true, true));
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary: { upstream_protocol: "anthropic_messages" },
      compact: { upstream_mode: "split", upstream_protocol: "anthropic_messages" }
    });
    const response = await postJson(app.url, compact ? "/v1/responses/compact" : "/v1/responses", { model: "synthetic", input: "Hello", stream: true });
    const events = sseDataFrames(await response.text()).map(data => JSON.parse(data));
    const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(response.status).toBe(200);
    expect(log.stream_outcome).not.toBe("success");
    expect(events.filter(event => event.type === "response.failed")).toHaveLength(1);
    expect(events.filter(event => event.type === "response.completed")).toHaveLength(0);
  });
});
