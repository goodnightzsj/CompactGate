import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicStreamObserver, createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { applyOpenAiProxyUpstreamResult, applyUpstreamFailureToTransaction, createOpenAiProxyTransactionState } from "../src/server/openai-proxy-transaction.js";
import { generationTokensPerSecond, readGenerationSample } from "../src/shared/generation-metrics.js";

afterEach(() => vi.restoreAllMocks());

function frame(value: Record<string, unknown>) {
  return Buffer.from(`${typeof value.type === "string" ? `event: ${value.type}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
}

function clock() {
  let value = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => value);
  return (next: number) => { value = next; };
}

describe("source-stream generation measurements", () => {
  it("does not mistake provisional message_start usage for final output usage", async () => {
    const at = clock();
    const observer = createAnthropicStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    observer.observe(frame({ type: "message_start", message: { usage: { output_tokens: 1 } } }));
    at(1100);
    observer.observe(frame({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }));
    at(2100);
    observer.observe(frame({ type: "message_stop" }));
    expect((await observer.finish()).generationSample).toBeNull();
  });

  it("validates stored samples and derives rates without confusing unknown with zero", () => {
    const sample = { first_output_ms: 100, duration_ms: 1000, output_tokens: 200 };
    expect(generationTokensPerSecond(sample)).toBe(200);
    expect(generationTokensPerSecond({ ...sample, output_tokens: 0 })).toBe(0);
    expect(generationTokensPerSecond({ ...sample, duration_ms: 99 })).toBeNull();
    expect(generationTokensPerSecond({ ...sample, duration_ms: 100 })).toBe(2000);
    for (const input of [null, undefined, {}, [], { ...sample, duration_ms: Infinity },
      { ...sample, first_output_ms: -1 }, { ...sample, output_tokens: "200" }, { ...sample, output_tokens: -1 },
      { ...sample, output_tokens: 1.5 }, { ...sample, duration_ms: -1 }]) {
      expect(readGenerationSample(input)).toBeNull();
      expect(generationTokensPerSecond(input)).toBeNull();
    }
  });

  it("carries only the source attempt sample and clears it on a new result or failure", async () => {
    const at = clock();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    at(1100);
    observer.observe(frame({ type: "response.output_text.delta", delta: "a" }));
    at(2100);
    observer.observe(frame({ type: "response.completed", response: { usage: { output_tokens: 10 } } }));
    const source = await observer.finish();
    const result = {
      status: 200, errorSummary: null, responseBody: Buffer.alloc(0), responseBodyTruncated: false,
      responseHeaders: {}, firstTokenMs: 50, clientDisconnectPhase: "none" as const, streamSummary: source,
      clientStreamSummary: { ...source, generationSample: { first_output_ms: 1090, duration_ms: 10, output_tokens: 999 } }
    };
    const state = createOpenAiProxyTransactionState();
    applyOpenAiProxyUpstreamResult(state, result);
    expect(state.generationSample).toEqual({ first_output_ms: 100, duration_ms: 1000, output_tokens: 10 });
    applyOpenAiProxyUpstreamResult(state, { ...result, streamSummary: null });
    expect(state.generationSample).toBeNull();
    applyOpenAiProxyUpstreamResult(state, result);
    applyUpstreamFailureToTransaction(state, { ...result, kind: "timeout" });
    expect(state.generationSample).toBeNull();
  });

  it("ignores envelopes and empty deltas, freezes at completion, and excludes HTTP cleanup", async () => {
    const at = clock();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    at(1100);
    observer.observe(frame({ type: "response.created", response: { usage: null } }));
    observer.observe(Buffer.from(": ping\n\n"));
    observer.observe(Buffer.from("event: ping\ndata:\n\n"));
    observer.observe(frame({ type: "response.output_text.delta", delta: "" }));
    observer.observe(frame({ type: "future.delta", delta: "not a known output" }));
    at(1200);
    observer.observe(frame({ type: "response.output_text.delta", delta: "hello" }));
    at(2200);
    observer.observe(frame({ type: "response.completed", response: { usage: { output_tokens: 200 } } }));
    at(9000);
    observer.observe(frame({ usage: { output_tokens: 9999 } }));
    observer.observe(Buffer.from("data: [DONE]\n\n"));
    expect((await observer.finish()).generationSample).toEqual({ first_output_ms: 200, duration_ms: 1000, output_tokens: 200 });
  });

  it.each([
    { type: "response.reasoning_text.delta", delta: "thinking" },
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.function_call_arguments.delta", delta: "{" },
    { type: "response.custom_tool_call_input.delta", delta: "code" },
    { type: "response.output_item.added", item: { type: "function_call", name: "read", arguments: "" } }
  ])("starts on supported Responses output: $type", async (output) => {
    const at = clock();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    at(1300);
    observer.observe(frame(output));
    at(2300);
    observer.observe(frame({ type: "response.completed", response: { usage: { output_tokens: 100, output_tokens_details: { reasoning_tokens: 80 } } } }));
    expect((await observer.finish()).generationSample).toEqual({ first_output_ms: 300, duration_ms: 1000, output_tokens: 100 });
  });

  it.each([
    { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } },
    { type: "content_block_start", content_block: { type: "tool_use", name: "read", id: "tool_1", input: {} } },
    { type: "content_block_start", content_block: { type: "text", text: "a" } }
  ])("measures Anthropic text, thinking and tools without double-counting usage", async (output) => {
    const at = clock();
    const observer = createAnthropicStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    at(1100);
    observer.observe(frame({ type: "message_start", message: { usage: { output_tokens: 0 } } }));
    observer.observe(frame({ type: "content_block_start", content_block: { type: "text", text: "" } }));
    observer.observe(frame({ type: "content_block_delta", delta: { type: "signature_delta", signature: "opaque" } }));
    at(1400);
    observer.observe(frame(output));
    at(2300);
    observer.observe(frame({ type: "message_delta", usage: { output_tokens: 150, reasoning_tokens: 100 } }));
    at(2400);
    observer.observe(frame({ type: "message_stop", usage: { output_tokens: 0 } }));
    expect((await observer.finish()).generationSample).toEqual({ first_output_ms: 400, duration_ms: 1000, output_tokens: 150 });
  });

  it.each([
    { content: "a" },
    { reasoning_content: "thinking" },
    { tool_calls: [{ index: 0, function: { name: "read", arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: "{" } }] }
  ])("measures Chat content and waits for usage before DONE", async (delta) => {
    const at = clock();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    at(1100);
    observer.observe(frame({ choices: [{ delta: { role: "assistant", content: "" } }] }));
    at(1500);
    observer.observe(frame({ choices: [{ delta }] }));
    at(2100);
    observer.observe(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    at(2400);
    observer.observe(frame({ choices: [], usage: { completion_tokens: 125 } }));
    at(2500);
    observer.observe(Buffer.from("data: [DONE]\n\n"));
    expect((await observer.finish()).generationSample).toEqual({ first_output_ms: 500, duration_ms: 1000, output_tokens: 125 });
  });

  it.each(["missing usage", "missing output", "missing terminal", "failed", "incomplete", "malformed", "oversized"])("does not invent a sample for %s", async (condition) => {
    const at = clock();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000, maxEventBytes: 256 })!;
    at(1200);
    if (condition !== "missing output") observer.observe(frame({ type: "response.output_text.delta", delta: "a" }));
    if (condition === "malformed") observer.observe(Buffer.from("data: {broken\n\n"));
    if (condition === "oversized") observer.observe(frame({ type: "response.output_text.delta", delta: "x".repeat(512) }));
    at(2200);
    if (condition !== "missing terminal") observer.observe(frame({
      type: condition === "failed" ? "response.failed" : condition === "incomplete" ? "response.incomplete" : "response.completed",
      response: { usage: condition === "missing usage" ? null : { output_tokens: 100 } }
    }));
    expect((await observer.finish()).generationSample).toBeNull();
  });

  it("timestamps a completed frame, not its first partial network chunk", async () => {
    const at = clock();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    const output = frame({ type: "response.output_text.delta", delta: "你好" });
    at(1100);
    observer.observe(output.subarray(0, output.length - 2));
    at(1400);
    observer.observe(output.subarray(output.length - 2));
    at(2400);
    observer.observe(frame({ type: "response.completed", response: { usage: { output_tokens: 10 } } }));
    expect((await observer.finish()).generationSample).toEqual({ first_output_ms: 400, duration_ms: 1000, output_tokens: 10 });
  });

  it("retains zero output and short measurements as facts rather than reusing another request", async () => {
    const at = clock();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    at(1100);
    observer.observe(frame({ type: "response.output_text.delta", delta: "a" }));
    at(1110);
    observer.observe(frame({ type: "response.completed", response: { usage: { output_tokens: 0 } } }));
    expect((await observer.finish()).generationSample).toEqual({ first_output_ms: 100, duration_ms: 10, output_tokens: 0 });
  });

  it("does not recover generation time from a terminal envelope or a non-stream response", async () => {
    clock();
    expect(createOpenAiStreamObserver({ "content-type": "application/json" }, { requestStartedAt: 1000 })).toBeNull();
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { requestStartedAt: 1000 })!;
    observer.observe(frame({ type: "response.completed", response: { output: [{ type: "message", content: [{ text: "a" }] }], usage: { output_tokens: 10 } } }));
    expect((await observer.finish()).generationSample).toBeNull();
  });

  it("observes compressed source frames and rejects decompression errors", async () => {
    clock();
    const body = Buffer.concat([
      frame({ type: "response.output_text.delta", delta: "a" }),
      frame({ type: "response.completed", response: { usage: { output_tokens: 10 } } })
    ]);
    const valid = createOpenAiStreamObserver({ "content-type": "text/event-stream", "content-encoding": "gzip" }, { requestStartedAt: 1000 })!;
    valid.observe(gzipSync(body));
    expect((await valid.finish()).generationSample).toEqual({ first_output_ms: 0, duration_ms: 0, output_tokens: 10 });
    const broken = createOpenAiStreamObserver({ "content-type": "text/event-stream", "content-encoding": "gzip" }, { requestStartedAt: 1000 })!;
    broken.observe(Buffer.from("not gzip"));
    expect(await broken.finish()).toMatchObject({ decodeError: true, generationSample: null });
  });
});
