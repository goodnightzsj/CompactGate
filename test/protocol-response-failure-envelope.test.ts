import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { openAiResponseToAnthropic } from "../src/server/protocol-conversion.js";
import { createResponsesToAnthropicStream } from "../src/server/protocol-stream.js";
import { sseDataFrames } from "../src/server/sse-frames.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

const failure = { type: "server_error", message: "Synthetic provider failure." };
const variants = [
  { name: "completed plus error", status: "completed", error: failure, failed: true },
  { name: "failed plus error", status: "failed", error: failure, failed: true },
  { name: "failed without error", status: "failed", error: null, failed: true },
  { name: "string error", status: "completed", error: "Synthetic provider failure.", failed: true },
  { name: "ordinary success", status: "completed", error: null, failed: false }
];
function responseBody(variant: typeof variants[number]) {
  return { id: "resp_synthetic", object: "response", model: "synthetic", status: variant.status,
    output: [{ id: "msg_synthetic", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Partial synthetic output.", annotations: [] }] }],
    error: variant.error, usage: { input_tokens: 4, output_tokens: 3 } };
}
function source(variant: typeof variants[number]) {
  const body = responseBody(variant);
  return `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: body })}\n\n`;
}

describe("Responses failure envelope at Anthropic boundary", () => {
  it.each(["authentication_error", "rate_limit_error", "invalid_request_error"])("preserves an embedded %s under HTTP 200", type => {
    const client = JSON.parse(openAiResponseToAnthropic(Buffer.from(JSON.stringify({
      status: "failed", error: { type, message: "Synthetic typed failure." }
    })), 200).toString());
    expect(client).toEqual({ type: "error", error: { type, message: "Synthetic typed failure." } });
  });
  it.each(variants)("JSON preserves $name", variant => {
    const client = JSON.parse(openAiResponseToAnthropic(Buffer.from(JSON.stringify(responseBody(variant))), 200).toString());
    expect(client.type).toBe(variant.failed ? "error" : "message");
    if (variant.failed) expect(client.error.message).toContain(variant.error ? "Synthetic provider failure" : "failed");
  });
  it.each(variants)("SSE preserves $name", async variant => {
    const transform = createResponsesToAnthropicStream();
    Readable.from([source(variant), 'data: {"type":"response.output_text.delta","delta":"Late output"}\n\n', source(variants[4])]).pipe(transform);
    const chunks: Buffer[] = [];
    for await (const chunk of transform) chunks.push(Buffer.from(chunk));
    const events = sseDataFrames(Buffer.concat(chunks).toString()).map(data => JSON.parse(data));
    expect(JSON.stringify(events)).not.toContain("Late output");
    expect({ errors: events.filter(event => event.type === "error").length,
      stops: events.filter(event => event.type === "message_stop").length })
      .toEqual({ errors: variant.failed ? 1 : 0, stops: variant.failed ? 0 : 1 });
  });
  it.each(variants)("HTTP preserves $name and its source attribution", async variant => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(source(variant));
    });
    const app = await startApp(upstream.url, undefined, { claude: { primary: {
      base_url: upstream.url, upstream_protocol: "openai_responses"
    } } });
    const response = await postJson(app.url, "/anthropic/v1/messages", {
      model: "synthetic", max_tokens: 16, stream: true, messages: [{ role: "user", content: "Hello" }]
    });
    const events = sseDataFrames(await response.text()).map(data => JSON.parse(data));
    const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log.stream_outcome === "success").toBe(!variant.failed);
    expect({ errors: events.filter(event => event.type === "error").length,
      stops: events.filter(event => event.type === "message_stop").length })
      .toEqual({ errors: variant.failed ? 1 : 0, stops: variant.failed ? 0 : 1 });
  });
});
