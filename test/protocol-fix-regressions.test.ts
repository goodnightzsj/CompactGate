import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  createAnthropicToResponsesStream,
  createChatToResponsesStream,
  createResponsesToAnthropicStream
} from "../src/server/protocol-stream.js";
import {
  anthropicUsageToResponses,
  responsesRequestToAnthropic
} from "../src/server/protocol-conversion.js";
import { extractUsageFromJsonText } from "../src/server/usage-record.js";

async function drain(transform: NodeJS.ReadWriteStream, frames: string[]): Promise<string> {
  const chunks: Buffer[] = [];
  Readable.from(frames).pipe(transform);
  for await (const chunk of transform) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parsed(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe("a translated Anthropic usage is not mistaken for the additive dialect", () => {
  it("reports the cache write without adding the cache on top of a total that has it", () => {
    // anthropicUsageToResponses emits OpenAI semantics: input_tokens already
    // *contains* the cache. Feeding its nested cache_write_tokens into the additive
    // channel told the analytics layer to add the cache again — inflating input by
    // the cache size and collapsing the hit rate on the model-path panel.
    const translated = anthropicUsageToResponses({
      input_tokens: 100,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 200,
      output_tokens: 50
    });
    const metrics = extractUsageFromJsonText(JSON.stringify({ usage: translated }));

    expect(metrics).toMatchObject({
      inputTokens: 800,
      outputTokens: 50,
      cachedInputTokens: 500,
      cacheCreationInputTokens: 200,
      additiveCachedInputTokens: false,
      totalTokens: 850
    });
  });
});

describe("a Chat upstream that omits tool_call index still produces one usable call", () => {
  it("continues the most recent slot for a frame carrying neither index nor id", async () => {
    // Real upstreams that omit `index` also omit `id` after the first frame. Keying
    // purely on the id sent every argument fragment to slot 0, where it conjured a
    // second nameless call and failed the whole stream with a 502.
    const out = await drain(createChatToResponsesStream(), [
      sse("chunk", {
        id: "chatcmpl_1",
        model: "gpt-5.5-chat",
        choices: [{ index: 0, delta: { tool_calls: [{ id: "call_a", type: "function", function: { name: "exec" } }] } }]
      }),
      sse("chunk", {
        choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: "{\"cmd\":" } }] } }]
      }),
      sse("chunk", {
        choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: "\"ls\"}" } }] }, finish_reason: "tool_calls" }]
      }),
      "data: [DONE]\n\n"
    ]);

    const events = parsed(out);
    expect(events.some((event) => event.type === "response.failed")).toBe(false);
    const completed = events.find((event) => event.type === "response.completed");
    const output = (completed?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    const calls = output.filter((item) => item.type === "function_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call_id: "call_a", name: "exec", arguments: "{\"cmd\":\"ls\"}" });
  });

  it("keeps parallel calls apart when only their first frames carry an id", async () => {
    // The original `?? 0` merged them into one call whose name was the
    // concatenation of both, which is what the slot-by-id change set out to fix.
    const out = await drain(createChatToResponsesStream(), [
      sse("chunk", {
        id: "chatcmpl_2",
        model: "gpt-5.5-chat",
        choices: [{ index: 0, delta: { tool_calls: [{ id: "call_a", type: "function", function: { name: "read" } }] } }]
      }),
      sse("chunk", {
        choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: "{\"a\":1}" } }] } }]
      }),
      sse("chunk", {
        choices: [{ index: 0, delta: { tool_calls: [{ id: "call_b", type: "function", function: { name: "write" } }] } }]
      }),
      sse("chunk", {
        choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: "{\"b\":2}" } }] }, finish_reason: "tool_calls" }]
      }),
      "data: [DONE]\n\n"
    ]);

    const completed = parsed(out).find((event) => event.type === "response.completed");
    const output = (completed?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    const calls = output.filter((item) => item.type === "function_call");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.name)).toEqual(["read", "write"]);
    expect(calls.map((call) => call.arguments)).toEqual(["{\"a\":1}", "{\"b\":2}"]);
  });
});

describe("message_delta cannot shrink the cumulative input total", () => {
  it("keeps message_start's total when the delta restates only the fresh part", async () => {
    const out = await drain(createAnthropicToResponsesStream(), [
      sse("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude",
          usage: { input_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 }
        }
      }),
      // A relay that echoes input_tokens without the cache split: the translated
      // value is a derived sum, so adopting it would drop to 100 and leave
      // cached_tokens (500) larger than input_tokens — which downstream reads as an
      // additive dialect.
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 100, output_tokens: 42 } }),
      sse("message_stop", { type: "message_stop" })
    ]);

    const completed = parsed(out).find((event) => event.type === "response.completed");
    const usage = (completed?.response as Record<string, unknown>).usage as Record<string, number>;
    expect(usage.input_tokens).toBe(800);
    expect(usage.input_tokens).toBeGreaterThanOrEqual(
      (usage.input_tokens_details as unknown as Record<string, number>).cached_tokens
    );
  });
});

describe("disabling parallel tool calls says nothing when there are no tools", () => {
  it("omits tool_choice for a request that declares none", () => {
    const withoutTools = JSON.parse(responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "claude-sonnet-4-6",
      input: "hi",
      parallel_tool_calls: false
    }))).toString("utf8"));
    expect(withoutTools).not.toHaveProperty("tool_choice");

    const withTools = JSON.parse(responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "claude-sonnet-4-6",
      input: "hi",
      parallel_tool_calls: false,
      tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: {} } }]
    }))).toString("utf8"));
    expect(withTools.tool_choice).toMatchObject({ type: "auto", disable_parallel_tool_use: true });
  });
});

describe("content block indices follow start order with no gaps", () => {
  it("numbers mixed block types by when they open, not when they were created", async () => {
    // Lazy allocation moved the invariant: indices now track the order blocks
    // *start*, which is the order they appear in the final message.content array —
    // the thing Anthropic's `index` actually means. A block created earlier but
    // never started (or started later) must not reserve a position.
    const out = await drain(createResponsesToAnthropicStream(), [
      sse("response.created", { type: "response.created", response: { id: "resp_x", model: "m" } }),
      // Created first, never starts: no summary and no encrypted_content.
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [] }
      }),
      // Starts first, so it must take index 0.
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "exec", arguments: "" }
      }),
      // Starts second, so index 1.
      sse("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 2,
        content_index: 0,
        delta: "done"
      }),
      sse("response.completed", {
        type: "response.completed",
        response: { id: "resp_x", model: "m", status: "completed", output: [] }
      })
    ]);

    const starts = parsed(out).filter((event) => event.type === "content_block_start");
    expect(starts.map((event) => event.index)).toEqual([0, 1]);
    expect((starts[0].content_block as Record<string, unknown>).type).toBe("tool_use");
    expect((starts[1].content_block as Record<string, unknown>).type).toBe("text");
  });
});
