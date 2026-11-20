import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { anthropicMessageToResponsesCompaction } from "../src/server/protocol-conversion.js";
import { createAnthropicToResponsesCompactionStream } from "../src/server/protocol-stream.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 5 };
const source = [
  { type: "message_start", message: { id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic", content: [], usage: { ...usage, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "compaction", content: "Synthetic summary." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "compaction", stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: "message_stop" }
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

it.each([false, true])("keeps identical compaction usage for JSON and SSE, zero trailer=%s", async zeroTrailer => {
  const trailer = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
  } })}\n\n`;
  const converted = Readable.from([zeroTrailer ? source.replace("event: message_stop", trailer + "event: message_stop") : source])
    .pipe(createAnthropicToResponsesCompactionStream());
  const chunks: Buffer[] = [];
  for await (const chunk of converted) chunks.push(Buffer.from(chunk));
  const events = Buffer.concat(chunks).toString().split("\n\n").filter(Boolean)
    .map(frame => JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
  const streamed = events.find(event => event.type === "response.completed").response;
  const json = JSON.parse(anthropicMessageToResponsesCompaction(Buffer.from(JSON.stringify({
    id: "msg_synthetic", type: "message", content: [{ type: "compaction", content: "Synthetic summary." }], usage
  })), 200).toString());
  expect(streamed.usage).toEqual(json.usage);
});

it("records the whole prompt and cache split for a real translated compact SSE request", async () => {
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(source);
  });
  const app = await startApp(upstream.url, upstream.url, {
    compact: { upstream_mode: "split", upstream_protocol: "anthropic_messages" }
  });
  const response = await postJson(app.url, "/v1/responses/compact", { model: "synthetic", input: "Summarize.", stream: true });
  await response.text();
  expect(response.status).toBe(200);
  const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
  expect(log).toMatchObject({ stream_outcome: "success", input_tokens: 1050, cached_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 5 });
});
