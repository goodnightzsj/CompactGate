import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createAnthropicPassthroughResponseTransform } from "../src/server/protocol-stream.js";
import { createAnthropicStreamObserver } from "../src/server/upstream-openai-stream.js";

describe("Anthropic stream observer", () => {
  it("treats message_stop as a successful terminal event and extracts metrics", async () => {
    const observer = createAnthropicStreamObserver({
      "content-type": "text/event-stream"
    });
    const stream = [
      anthropicEvent("message_start", {
        type: "message_start",
        message: {
          model: "claude-sonnet-test",
          usage: {
            input_tokens: 7,
            cache_read_input_tokens: 3,
            output_tokens: 1
          }
        }
      }),
      anthropicEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" }
      }),
      anthropicEvent("message_delta", {
        type: "message_delta",
        usage: { output_tokens: 5 }
      }),
      anthropicEvent("message_stop", { type: "message_stop" })
    ].join("");

    observer?.observe(Buffer.from(stream));

    expect(await observer?.finish()).toMatchObject({
      eventCount: 4,
      sawTerminalEvent: true,
      sawCompletedEvent: true,
      sawFailedEvent: false,
      sawOutputEvent: true,
      terminalEvent: "message_stop",
      responseModel: "claude-sonnet-test",
      usage: {
        inputTokens: 7,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        totalTokens: 15
      }
    });
  });

  it("observes complete Brotli encoded Anthropic streams", async () => {
    const observer = createAnthropicStreamObserver({
      "content-type": "text/event-stream",
      "content-encoding": "br"
    });
    const stream = [
      anthropicEvent("message_start", {
        type: "message_start",
        message: {
          model: "claude-opus-test",
          usage: { input_tokens: 11, output_tokens: 1 }
        }
      }),
      anthropicEvent("message_delta", {
        type: "message_delta",
        usage: { output_tokens: 4 }
      }),
      anthropicEvent("message_stop", { type: "message_stop" })
    ].join("");

    observer?.observe(brotliCompressSync(Buffer.from(stream)));

    expect(await observer?.finish()).toMatchObject({
      eventCount: 3,
      sawCompletedEvent: true,
      terminalEvent: "message_stop",
      responseModel: "claude-opus-test",
      usage: {
        inputTokens: 11,
        outputTokens: 4,
        totalTokens: 15
      }
    });
  });

  it("classifies an HTTP 200 error event as a terminal provider failure", async () => {
    const observer = createAnthropicStreamObserver({
      "content-type": "text/event-stream"
    });
    observer?.observe(Buffer.from(anthropicEvent("error", {
      type: "error",
      error: {
        type: "overloaded_error",
        message: "Overloaded"
      }
    })));

    expect(await observer?.finish()).toMatchObject({
      eventCount: 1,
      sawTerminalEvent: true,
      sawCompletedEvent: false,
      sawFailedEvent: true,
      terminalEvent: "error",
      errorSummary: "Overloaded (overloaded_error)"
    });
  });

  it("ignores unknown events without losing a later message_stop", async () => {
    const observer = createAnthropicStreamObserver({
      "content-type": "text/event-stream"
    });
    observer?.observe(Buffer.from([
      anthropicEvent("future_event", { type: "future_event", value: 1 }),
      anthropicEvent("message_stop", { type: "message_stop" })
    ].join("")));

    expect(await observer?.finish()).toMatchObject({
      eventCount: 2,
      sawCompletedEvent: true,
      terminalEvent: "message_stop"
    });
  });
});

describe("Anthropic passthrough terminator repair", () => {
  const truncated = [
    anthropicEvent("message_start", {
      type: "message_start",
      message: { model: "glm-5.3", usage: { input_tokens: 27824, output_tokens: 0 } }
    }),
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" }
    }),
    anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text" }
    }),
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "我是" }
    })
  ].join("");

  it("closes the open block and appends the terminator a cut stream never sent", async () => {
    const output = await runTransform({ "content-type": "text/event-stream" }, truncated);

    // The bytes that did arrive are forwarded untouched.
    expect(output.startsWith(truncated)).toBe(true);
    const appended = output.slice(truncated.length);
    expect(appended).toContain('"type":"content_block_stop","index":1');
    expect(appended).not.toContain('"index":0');
    expect(appended).toContain('"stop_reason":"end_turn"');
    // Usage observed on message_start survives, so the turn is not billed as empty.
    expect(appended).toContain('"input_tokens":27824');
    expect(appended.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it("repairs a brotli-compressed cut stream and drops the stale content-encoding", async () => {
    const headers = { "content-type": "text/event-stream", "content-encoding": "br" };
    const transform = createAnthropicPassthroughResponseTransform(200, headers);

    expect(transform?.responseHeaders["content-encoding"]).toBeUndefined();
    const output = await runTransform(headers, brotliCompressSync(Buffer.from(truncated)));
    expect(output.startsWith(truncated)).toBe(true);
    expect(output).toContain('"type":"message_stop"');
  });

  it("leaves a stream that terminated properly byte for byte", async () => {
    const complete = `${truncated}${[
      anthropicEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      anthropicEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 12 }
      }),
      anthropicEvent("message_stop", { type: "message_stop" })
    ].join("")}`;

    expect(await runTransform({ "content-type": "text/event-stream" }, complete)).toBe(complete);
  });

  it("keeps the single message_stop when the upstream only lost that one event", async () => {
    const noStop = `${truncated}${[
      anthropicEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
      anthropicEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 12 }
      })
    ].join("")}`;

    const appended = (await runTransform({ "content-type": "text/event-stream" }, noStop)).slice(noStop.length);
    // message_delta already arrived, so it must not be emitted a second time.
    expect(appended).not.toContain("message_delta");
    expect(appended.trimEnd()).toBe('event: message_stop\ndata: {"type":"message_stop"}');
  });

  it("does not wrap a non-stream body that has no terminator to repair", () => {
    expect(createAnthropicPassthroughResponseTransform(200, { "content-type": "application/json" })).toBeNull();
  });
});

async function runTransform(headers: Record<string, string>, input: Buffer | string): Promise<string> {
  const transform = createAnthropicPassthroughResponseTransform(200, headers);
  if (!transform) {
    throw new Error("expected a transform for an event-stream response");
  }
  const chunks: Buffer[] = [];
  transform.stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => {
    transform.stream.once("end", resolve);
    transform.stream.once("error", reject);
  });
  transform.stream.end(typeof input === "string" ? Buffer.from(input) : input);
  await done;
  return Buffer.concat(chunks).toString("utf8");
}

function anthropicEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
