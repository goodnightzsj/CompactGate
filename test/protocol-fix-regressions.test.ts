import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingHttpHeaders } from "node:http";
import {
  createAnthropicToResponsesStream,
  createAnthropicToResponsesCompactionResponseTransform,
  createChatToResponsesStream,
  createResponsesToAnthropicStream
} from "../src/server/protocol-stream.js";
import {
  anthropicUsageToResponses,
  responsesRequestToAnthropic,
  responsesRequestToChat
} from "../src/server/protocol-conversion.js";
import { extractUsageFromJsonText } from "../src/server/usage-record.js";
import { extractResponseUsage } from "../src/server/usage.js";
import { classifyPrimaryRouteResult } from "../src/server/primary-failover-result.js";
import type { PrimaryRouteResult } from "../src/server/primary-failover-types.js";

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

  it("splits two calls that both claim index 0 but name different ids", async () => {
    // Preferring the index outright let an upstream that restarts `index` per call
    // put both on one slot, emitting a single call whose name was "readwrite" and
    // whose arguments were two JSON objects concatenated — a tool no client has.
    const out = await drain(createChatToResponsesStream(), [
      sse("chunk", {
        id: "chatcmpl_3",
        model: "gpt-5.5-chat",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "{\"a\":1}" } }] } }]
      }),
      sse("chunk", {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_b", type: "function", function: { name: "write", arguments: "{\"b\":2}" } }] }, finish_reason: "tool_calls" }]
      }),
      "data: [DONE]\n\n"
    ]);

    const completed = parsed(out).find((event) => event.type === "response.completed");
    const output = (completed?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    const calls = output.filter((item) => item.type === "function_call");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.name)).toEqual(["read", "write"]);
  });

  it("keeps one call together when the index only appears after the first frame", async () => {
    // The id got its own high slot, then the index sent the arguments to slot 0,
    // where a nameless call failed the stream. The id now decides the slot and
    // remembers the index bound to it.
    const out = await drain(createChatToResponsesStream(), [
      sse("chunk", {
        id: "chatcmpl_4",
        model: "gpt-5.5-chat",
        choices: [{ index: 0, delta: { tool_calls: [{ id: "call_a", type: "function", function: { name: "read" } }] } }]
      }),
      sse("chunk", {
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { arguments: "{\"a\":1}" } }] }, finish_reason: "tool_calls" }]
      }),
      "data: [DONE]\n\n"
    ]);

    const events = parsed(out);
    expect(events.some((event) => event.type === "response.failed")).toBe(false);
    const completed = events.find((event) => event.type === "response.completed");
    const output = (completed?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    const calls = output.filter((item) => item.type === "function_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call_id: "call_a", name: "read", arguments: "{\"a\":1}" });
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

  it("keeps the output count when a later frame restates usage as zeros", async () => {
    // Some relays append a zero-filled usage to every frame after the real one.
    // The input total was already guarded; its sibling was not, so the count the
    // client and the log both read collapsed to zero at the last moment.
    const out = await drain(createAnthropicToResponsesStream(), [
      sse("message_start", {
        type: "message_start",
        message: { id: "msg_2", model: "claude", usage: { input_tokens: 100, output_tokens: 1 } }
      }),
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 100, output_tokens: 812 }
      }),
      sse("message_delta", { type: "message_delta", delta: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
      sse("message_stop", { type: "message_stop" })
    ]);

    const completed = parsed(out).find((event) => event.type === "response.completed");
    const usage = (completed?.response as Record<string, unknown>).usage as Record<string, number>;
    expect(usage.output_tokens).toBe(812);
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

  it("omits parallel_tool_calls on the Chat direction too", () => {
    // OpenAI rejects the pair outright when `tools` is absent, so forwarding it
    // turned a request that would have worked into a 400 from the upstream.
    const withoutTools = JSON.parse(responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      input: "hi",
      parallel_tool_calls: false
    }))).toString("utf8")) as Record<string, unknown>;
    expect(withoutTools).not.toHaveProperty("tools");
    expect(withoutTools).not.toHaveProperty("parallel_tool_calls");

    const withTools = JSON.parse(responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      input: "hi",
      parallel_tool_calls: false,
      tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: {} } }]
    }))).toString("utf8")) as Record<string, unknown>;
    expect(withTools.parallel_tool_calls).toBe(false);
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

  it("never puts the unassigned index on the wire", async () => {
    // An upstream that omits `output_index` on the arguments frame resolves to
    // slot 0, which is a different and unstarted block whenever the real call sat
    // at a later output index. The `.delta` branch already declined to emit for an
    // unstarted block; the `.done` branch emitted `index: -1`, and a consumer that
    // assigns by index writes that to the end of its array.
    const out = await drain(createResponsesToAnthropicStream(), [
      sse("response.created", { type: "response.created", response: { id: "resp_y", model: "m" } }),
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "exec", arguments: "" }
      }),
      sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        arguments: "{\"cmd\":\"ls\"}"
      }),
      sse("response.completed", {
        type: "response.completed",
        response: { id: "resp_y", model: "m", status: "completed", output: [] }
      })
    ]);

    expect(parsed(out).filter((event) => event.index === -1)).toEqual([]);
  });

  it("translates a custom tool call instead of failing the stream", async () => {
    // A freeform tool call was an unsupported item type here, so one of them
    // ended the whole response with a 502 — while the request direction has
    // always translated the matching input item. Anthropic's tool_use.input is
    // an object, so the text goes under a single key rather than being parsed as
    // JSON it is not.
    const out = await drain(createResponsesToAnthropicStream(), [
      sse("response.created", { type: "response.created", response: { id: "resp_z", model: "m" } }),
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "ctc_1", type: "custom_tool_call", call_id: "call_1", name: "shell", input: "" }
      }),
      sse("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta", output_index: 0, delta: "ls "
      }),
      sse("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta", output_index: 0, delta: "-la"
      }),
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "ctc_1", type: "custom_tool_call", call_id: "call_1", name: "shell", input: "ls -la" }
      }),
      sse("response.completed", {
        type: "response.completed",
        response: { id: "resp_z", model: "m", status: "completed", output: [] }
      })
    ]);

    const events = parsed(out);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const start = events.find((event) => event.type === "content_block_start");
    expect(start?.content_block).toMatchObject({ type: "tool_use", id: "call_1", name: "shell" });
    const json = events
      .filter((event) => event.type === "content_block_delta")
      .map((event) => (event.delta as Record<string, unknown>).partial_json as string)
      .join("");
    expect(JSON.parse(json)).toEqual({ input: "ls -la" });
  });

  it("emits a custom tool's input once when both closing events arrive", async () => {
    // Its fragments are buffered, so the emit moved to the close — and a stream
    // can close the same call twice, once with the input event and again with the
    // item event plus the final output array.
    const item = {
      id: "ctc_1", type: "custom_tool_call", call_id: "call_1", name: "shell", input: "ls -la"
    };
    const out = await drain(createResponsesToAnthropicStream(), [
      sse("response.created", { type: "response.created", response: { id: "r", model: "m" } }),
      sse("response.output_item.added", {
        type: "response.output_item.added", output_index: 0, item: { ...item, input: "" }
      }),
      sse("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta", output_index: 0, delta: "ls -la"
      }),
      sse("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done", output_index: 0, input: "ls -la"
      }),
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }),
      sse("response.completed", {
        type: "response.completed",
        response: { id: "r", model: "m", status: "completed", output: [item] }
      })
    ]);

    const events = parsed(out);
    expect(events.filter((event) => event.type === "content_block_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "content_block_delta")).toHaveLength(1);
    expect(events.filter((event) => event.type === "content_block_stop")).toHaveLength(1);
  });

  it("still streams a function call's fragments and adds nothing at its close", async () => {
    // The emit-once flag is shared, so the ordinary function path has to keep
    // streaming per fragment and keep adding no extra delta when the item closes.
    const item = {
      id: "fc_1", type: "function_call", call_id: "call_1", name: "exec", arguments: "{\"cmd\":\"ls\"}"
    };
    const out = await drain(createResponsesToAnthropicStream(), [
      sse("response.created", { type: "response.created", response: { id: "r", model: "m" } }),
      sse("response.output_item.added", {
        type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" }
      }),
      sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"cmd\":"
      }),
      sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta", output_index: 0, delta: "\"ls\"}"
      }),
      sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done", output_index: 0, arguments: "{\"cmd\":\"ls\"}"
      }),
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }),
      sse("response.completed", {
        type: "response.completed",
        response: { id: "r", model: "m", status: "completed", output: [item] }
      })
    ]);

    const events = parsed(out);
    const deltas = events.filter((event) => event.type === "content_block_delta");
    expect(deltas).toHaveLength(2);
    expect(JSON.parse(deltas
      .map((event) => (event.delta as Record<string, unknown>).partial_json as string)
      .join(""))).toEqual({ cmd: "ls" });
    expect(events.filter((event) => event.type === "content_block_stop")).toHaveLength(1);
  });
});

describe("a 2xx whose body fails translation is not scored as a healthy profile", () => {
  it("leaves no usage on the body failover reads, so the profile is marked failed", async () => {
    // `classifyPrimaryRouteResult` short-circuits to "success" on usage before it
    // ever looks at the error summary, so the out-of-band translation error only
    // demotes the result while usage is absent too. What keeps that true is that
    // the proxy extracts usage from the *client* body — the error envelope, which
    // carries none — and not from the raw upstream body, which here carries a
    // perfectly good usage block. Nothing else pins which body is read.
    const upstreamRaw = JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      // Not the compaction block shape the converter demands, so it throws.
      content: [{ type: "text", text: "not a compaction block" }],
      usage: { input_tokens: 4321, output_tokens: 99 }
    });
    const headers = { "content-type": "application/json" };
    const transform = createAnthropicToResponsesCompactionResponseTransform(200, headers);
    const clientBody = Buffer.from(await drain(transform.stream, [upstreamRaw]), "utf8");

    // The client still gets a body rather than a destroyed socket, and the
    // failure is reported alongside it.
    expect(clientBody.byteLength).toBeGreaterThan(0);
    expect(transform.translationError).toBeTruthy();

    const classify = (body: Buffer, bodyHeaders: IncomingHttpHeaders): string =>
      classifyPrimaryRouteResult({
        status: 200,
        errorSummary: transform.translationError ?? null,
        usage: extractResponseUsage(body, bodyHeaders)
      } as unknown as PrimaryRouteResult);

    expect(extractResponseUsage(clientBody, transform.responseHeaders).inputTokens ?? 0).toBe(0);
    expect(classify(clientBody, transform.responseHeaders)).not.toBe("success");
    // The hazard is real if the raw upstream body is ever substituted here.
    expect(extractResponseUsage(Buffer.from(upstreamRaw), headers).inputTokens).toBe(4321);
    expect(classify(Buffer.from(upstreamRaw), headers)).toBe("success");
  });
});
