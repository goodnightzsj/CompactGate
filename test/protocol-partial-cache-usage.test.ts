import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { anthropicMessageToResponses, anthropicMessageToResponsesCompaction } from "../src/server/protocol-conversion.js";
import { createAnthropicToResponsesStream, createAnthropicToResponsesCompactionStream } from "../src/server/protocol-stream.js";
import { sseDataFrames } from "../src/server/sse-frames.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

const completeUsage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 5 };
type Kind = "ordinary" | "compact";
function source(kind: Kind, finalUsage: Record<string, number>, laterUsage: Record<string, number>[] = []): string {
  const block = kind === "compact" ? { type: "compaction", content: "Synthetic summary." } : { type: "text", text: "Synthetic answer." };
  return [
    { type: "message_start", message: { id: "msg_synthetic", model: "synthetic", usage: { ...completeUsage, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: kind === "compact" ? "compaction" : "end_turn" }, usage: finalUsage },
    ...laterUsage.map(usage => ({ type: "message_delta", delta: {}, usage })),
    { type: "message_stop" }
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

describe.each(["ordinary", "compact"] as const)("partial Anthropic usage: %s", kind => {
  it.each([
    ["complete", completeUsage],
    ["read-only", { cache_read_input_tokens: 900, output_tokens: 5 }],
    ["write-only", { cache_creation_input_tokens: 50, output_tokens: 5 }],
    ["read-with-zero-write", { cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 5 }],
    ["write-with-zero-read", { cache_creation_input_tokens: 50, cache_read_input_tokens: 0, output_tokens: 5 }],
    ["collapsed-cache", { input_tokens: 0, cache_read_input_tokens: 1050, cache_creation_input_tokens: 0, output_tokens: 5 }]
  ] as const)("retains both cache counters when final delta is %s", async (_label, finalUsage) => {
    const transform = kind === "compact" ? createAnthropicToResponsesCompactionStream() : createAnthropicToResponsesStream();
    const chunks: Buffer[] = [];
    Readable.from([source(kind, finalUsage)]).pipe(transform);
    for await (const chunk of transform) chunks.push(Buffer.from(chunk));
    const events = sseDataFrames(Buffer.concat(chunks).toString()).map(data => JSON.parse(data));
    const actual = events.find(event => event.type === "response.completed").response.usage;
    const convert = kind === "compact" ? anthropicMessageToResponsesCompaction : anthropicMessageToResponses;
    const content = kind === "compact" ? [{ type: "compaction", content: "Synthetic summary." }] : [{ type: "text", text: "Synthetic answer." }];
    const expected = JSON.parse(convert(Buffer.from(JSON.stringify({ id: "msg_synthetic", model: "synthetic", content, usage: completeUsage })), 200).toString()).usage;
    expect(actual).toEqual(expected);
  });

  it("merges growing partial counters before deriving the total", async () => {
    const transform = kind === "compact" ? createAnthropicToResponsesCompactionStream() : createAnthropicToResponsesStream();
    Readable.from([source(kind, { cache_read_input_tokens: 1000, output_tokens: 5 }, [
      { cache_creation_input_tokens: 70 }, { input_tokens: 120 },
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    ])]).pipe(transform);
    const chunks: Buffer[] = [];
    for await (const chunk of transform) chunks.push(Buffer.from(chunk));
    const events = sseDataFrames(Buffer.concat(chunks).toString()).map(data => JSON.parse(data));
    expect(events.find(event => event.type === "response.completed").response.usage).toEqual({
      input_tokens: 1190, output_tokens: 5, total_tokens: 1195,
      input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 70 }
    });
  });

  it("preserves cache creation in a real HTTP response and request log", async () => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(source(kind, { cache_read_input_tokens: 900, output_tokens: 5 }));
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary: { upstream_protocol: "anthropic_messages" },
      compact: { upstream_mode: "split", upstream_protocol: "anthropic_messages" }
    });
    const response = await postJson(app.url, kind === "compact" ? "/v1/responses/compact" : "/v1/responses", { model: "synthetic", input: "Hello", stream: true });
    const events = sseDataFrames(await response.text()).map(data => JSON.parse(data));
    const completed = events.find(event => event.type === "response.completed");
    expect(response.status).toBe(200);
    const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect({ usage: completed.response.usage, log: { input: log.input_tokens, read: log.cached_input_tokens, write: log.cache_creation_input_tokens } }).toEqual({
      usage: { input_tokens: 1050, output_tokens: 5, total_tokens: 1055, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 50 } },
      log: { input: 1050, read: 900, write: 50 }
    });
  });
});
