import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  anthropicMessageToResponses,
  anthropicMessageToResponsesCompaction,
  anthropicUsageToResponses
} from "../src/server/protocol-conversion.js";
import {
  createAnthropicToResponsesCompactionStream,
  createAnthropicToResponsesStream
} from "../src/server/protocol-stream.js";
import {
  captureRequest,
  postJson,
  startApp,
  startClaudeUpstream,
  waitForLogEntry
} from "./helpers/server-test-utils.js";

const usage = { input_tokens: 11, output_tokens: 36, reasoning_tokens: 26 };

function wire(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function terminal(sse: string) {
  const frames = sse.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  return frames.filter((frame) => ["response.completed", "response.incomplete", "response.failed"].includes(frame.type)).at(-1);
}

describe("Messages reasoning usage reaches downstream Responses", () => {
  it.each([26, 0, undefined, null, -1, 1.5, "26", NaN, Infinity])("only carries observed integer counts: %s", (reasoning) => {
    const converted = anthropicUsageToResponses({ ...usage, reasoning_tokens: reasoning });
    const details = typeof reasoning === "number" && Number.isInteger(reasoning) && reasoning >= 0
      ? { reasoning_tokens: reasoning }
      : undefined;
    expect(converted).toEqual({
      input_tokens: 11, output_tokens: 36, total_tokens: 47,
      ...(details ? { output_tokens_details: details } : {})
    });
  });

  it.each([anthropicMessageToResponses, anthropicMessageToResponsesCompaction])("preserves the split in JSON: %s", (convert) => {
    const response = JSON.parse(convert(Buffer.from(JSON.stringify({
      id: "synthetic", type: "message", model: "synthetic", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }, { type: "compaction", content: "summary" }], usage
    })), 200).toString());
    expect(response.usage).toEqual({
      input_tokens: 11, output_tokens: 36, total_tokens: 47,
      output_tokens_details: { reasoning_tokens: 26 }
    });
  });

  for (const [name, create] of [
    ["message", createAnthropicToResponsesStream],
    ["compaction", createAnthropicToResponsesCompactionStream]
  ] as const) {
    for (const atStart of [false, true]) {
      it.each(["complete", "error", "eof"])(`${name} preserves ${atStart ? "start" : "delta"} usage on %s`, async (ending) => {
        const events: unknown[] = [
          { type: "message_start", message: { id: "synthetic", model: "synthetic", usage: atStart ? usage : {} } },
          { type: "content_block_start", index: 0, content_block: { type: "compaction", content: "summary" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: atStart ? { input_tokens: 11, output_tokens: 36 } : usage },
          { type: "message_delta", usage: { input_tokens: 11, output_tokens: 36, reasoning_tokens: 0 } }
        ];
        if (ending === "complete") events.push({ type: "message_stop" });
        if (ending === "error") events.push({ type: "error", error: { type: "overloaded_error", message: "synthetic failure" } });
        const stream = Readable.from([wire(events)]).pipe(create());
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const last = terminal(Buffer.concat(chunks).toString());
        expect(last?.type).toBe(ending === "complete" ? "response.completed" : "response.failed");
        expect(last?.response.usage).toEqual({
          input_tokens: 11, output_tokens: 36, total_tokens: 47,
          output_tokens_details: { reasoning_tokens: 26 }
        });
      });
    }
  }

  it.each([false, true])("delivers and records the split through the HTTP proxy, stream=%s", async (stream) => {
    const upstream = await startClaudeUpstream(async (req, res) => {
      await captureRequest(req);
      const counted = { ...usage, cache_read_input_tokens: 90 };
      res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
      res.end(stream ? wire([
        { type: "message_start", message: { id: "synthetic", model: "synthetic", usage: {} } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: counted },
        { type: "message_stop" }
      ]) : JSON.stringify({
        id: "synthetic", model: "synthetic", type: "message", role: "assistant",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: counted
      }));
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, {
      primary: { upstream_protocol: "anthropic_messages", api_key: "synthetic-key", model_override: "synthetic" }
    });
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic", input: "hi", stream });
    expect(response.status).toBe(200);
    const text = await response.text();
    const delivered = stream ? terminal(text)?.response : JSON.parse(text);
    expect(delivered.usage).toEqual({
      input_tokens: 101, output_tokens: 36, total_tokens: 137,
      input_tokens_details: { cached_tokens: 90 }, output_tokens_details: { reasoning_tokens: 26 }
    });
    const entry = await waitForLogEntry(app.url, (row) => row.path === "/v1/responses");
    expect(entry).toMatchObject({ reasoning_tokens: 26, output_tokens: 36, total_tokens: 137 });
  });
});
