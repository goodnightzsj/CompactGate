import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
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

function anthropicEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
