import { describe, expect, it } from "vitest";
import {
  anthropicRequestToResponses,
  encodeCompactGateState,
  openAiInputTokensToAnthropic,
  openAiResponseToAnthropic,
  ProtocolConversionError
} from "../src/server/protocol-conversion.js";
import { createResponsesToAnthropicStream } from "../src/server/protocol-stream.js";
import {
  type CapturedRequest,
  startApp,
  startCapturedOpenAiUpstream
} from "./helpers/server-test-utils.js";
import { postClaudeMessage } from "./server-claude-core-helpers.js";

describe("Anthropic Messages to OpenAI Responses conversion", () => {
  it("maps system, media, thinking, tools, tool results, and limits", () => {
    const converted = anthropicRequestToResponses(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      system: [{ type: "text", text: "Be precise.", cache_control: { type: "ephemeral" } }],
      max_tokens: 6000,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 5000 },
      tools: [{
        name: "weather",
        description: "Read weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } }
      }],
      tool_choice: { type: "tool", name: "weather", disable_parallel_tool_use: true },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Weather?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" }
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Use the tool.",
              signature: encodeCompactGateState({
                kind: "openai_reasoning",
                encrypted_content: "reasoning-state",
                summary: "Use the tool."
              })
            },
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "call_1", name: "weather", input: { city: "Shanghai" } }
          ]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }]
        }
      ]
    })));
    const body = JSON.parse(converted.toString("utf8"));

    expect(body).toMatchObject({
      model: "gpt-5.5",
      max_output_tokens: 6000,
      stream: true,
      reasoning: { effort: "high", summary: "auto" },
      tools: [{
        type: "function",
        name: "weather",
        parameters: { type: "object", properties: { city: { type: "string" } } }
      }],
      tool_choice: { type: "function", name: "weather" },
      parallel_tool_calls: false
    });
    expect(body.input).toEqual([
      { type: "message", role: "system", content: [{ type: "input_text", text: "Be precise." }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Weather?" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }
        ]
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Use the tool." }],
        encrypted_content: "reasoning-state"
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Checking." }]
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "weather",
        arguments: "{\"city\":\"Shanghai\"}"
      },
      { type: "function_call_output", call_id: "call_1", output: "sunny" }
    ]);
  });

  it("keeps a mid-conversation system message at its position", () => {
    const converted = JSON.parse(anthropicRequestToResponses(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      system: "Top-level.",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "Hook fired." }] },
        { role: "assistant", content: "ok" }
      ]
    }))).toString("utf8"));
    expect(converted.input).toEqual([
      { type: "message", role: "system", content: [{ type: "input_text", text: "Top-level." }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "system", content: [{ type: "input_text", text: "Hook fired." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }
    ]);

    expect(() => anthropicRequestToResponses(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      messages: [{ role: "developer", content: "hi" }]
    })))).toThrow("Anthropic messages require user, assistant, or system roles.");
  });

  it("rejects provider-owned thinking and server-only request features", () => {
    expect(() => anthropicRequestToResponses(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      messages: [{
        role: "assistant",
        content: [{ type: "thinking", thinking: "private", signature: "provider-owned" }]
      }]
    })))).toThrow("Opaque thinking state was not created by CompactGate.");

    expect(() => anthropicRequestToResponses(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      top_k: 4,
      messages: [{ role: "user", content: "hello" }]
    })))).toThrowError(ProtocolConversionError);
    expect(() => anthropicRequestToResponses(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "search" }]
    })))).toThrow("Only Anthropic client tools can be translated");
  });

  it("maps Responses JSON output and usage to an Anthropic message", () => {
    const converted = openAiResponseToAnthropic(Buffer.from(JSON.stringify({
      id: "resp_json",
      object: "response",
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Check weather." }],
          encrypted_content: "encrypted-reasoning"
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Calling weather." }]
        },
        {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: "{\"city\":\"Shanghai\"}"
        }
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        input_tokens_details: { cached_tokens: 3 }
      }
    })), 200);
    const body = JSON.parse(converted.toString("utf8"));

    expect(body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "gpt-5.5",
      stop_reason: "tool_use",
      usage: { input_tokens: 9, output_tokens: 7, cache_read_input_tokens: 3 }
    });
    expect(body.content).toEqual([
      expect.objectContaining({ type: "thinking", thinking: "Check weather." }),
      { type: "text", text: "Calling weather." },
      { type: "tool_use", id: "call_1", name: "weather", input: { city: "Shanghai" } }
    ]);
    expect(body.content[0].signature).toMatch(/^cg1_/);
  });

  it("maps OpenAI errors and input-token counts to Anthropic JSON", () => {
    expect(JSON.parse(openAiResponseToAnthropic(Buffer.from(JSON.stringify({
      error: { type: "invalid_request_error", message: "bad input" }
    })), 400).toString("utf8"))).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "bad input" }
    });
    expect(JSON.parse(openAiInputTokensToAnthropic(Buffer.from(JSON.stringify({
      object: "response.input_tokens",
      input_tokens: 42
    })), 200).toString("utf8"))).toEqual({ input_tokens: 42 });
  });

  it("converts fragmented Responses SSE into one Anthropic message stream", async () => {
    const transform = createResponsesToAnthropicStream();
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    const reasoningItem = {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Think." }],
      encrypted_content: "reasoning-state"
    };
    const messageItem = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello" }]
    };
    const toolItem = {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "weather",
      arguments: "{\"city\":\"Shanghai\"}"
    };
    const source = [
      event("response.created", {
        type: "response.created",
        response: { id: "resp_stream", model: "gpt-5.5", output: [], usage: { input_tokens: 5, output_tokens: 0 } }
      }),
      event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", summary: [] } }),
      event("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Think." }),
      event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: reasoningItem }),
      event("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [] } }),
      event("response.content_part.added", { type: "response.content_part.added", output_index: 1, content_index: 0, part: { type: "output_text", text: "" } }),
      event("response.output_text.delta", { type: "response.output_text.delta", output_index: 1, content_index: 0, delta: "Hello" }),
      event("response.output_text.done", { type: "response.output_text.done", output_index: 1, content_index: 0, text: "Hello" }),
      event("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: messageItem }),
      event("response.output_item.added", { type: "response.output_item.added", output_index: 2, item: { ...toolItem, arguments: "" } }),
      event("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 2, delta: "{\"city\":\"Shanghai\"}" }),
      event("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: 2, arguments: "{\"city\":\"Shanghai\"}" }),
      event("response.output_item.done", { type: "response.output_item.done", output_index: 2, item: toolItem }),
      event("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_stream",
          status: "completed",
          model: "gpt-5.5",
          output: [reasoningItem, messageItem, toolItem],
          usage: { input_tokens: 5, output_tokens: 4 }
        }
      })
    ].join("");

    for (let offset = 0; offset < source.length; offset += 7) {
      transform.write(source.slice(offset, offset + 7));
    }
    transform.end();
    await new Promise<void>((resolve, reject) => {
      transform.once("end", resolve);
      transform.once("error", reject);
    });

    const events = parseEvents(Buffer.concat(chunks).toString("utf8"));
    expect(events.filter((item) => item.type === "message_start")).toHaveLength(1);
    expect(events.filter((item) => item.type === "message_stop")).toHaveLength(1);
    expect(events.filter((item) => item.type === "error")).toHaveLength(0);
    expect(events.filter((item) => item.type === "content_block_start").map((item) =>
      (item.content_block as { type?: string }).type
    )).toEqual(["thinking", "text", "tool_use"]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
      expect.objectContaining({ type: "content_block_delta", delta: expect.objectContaining({ type: "signature_delta" }) }),
      expect.objectContaining({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"city\":\"Shanghai\"}" } })
    ]));
    expect(events.find((item) => item.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 }
    });
  });

  it("proxies Claude JSON and count-token requests through an OpenAI Responses upstream", async () => {
    const captures: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(captures, (_req, res) => {
      const captured = captures.at(-1);
      if (captured?.url === "/v1/responses/input_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "response.input_tokens", input_tokens: 33 }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_proxy",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "proxied" }]
        }],
        usage: { input_tokens: 3, output_tokens: 2 }
      }));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: upstream.url,
          upstream_protocol: "openai_responses",
          api_key: "openai-secret",
          model_override: "gpt-5.5"
        }
      }
    });

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }]
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      model: "gpt-5.5",
      content: [{ type: "text", text: "proxied" }],
      usage: { input_tokens: 3, output_tokens: 2 }
    });
    expect(captures[0].url).toBe("/v1/responses");
    expect(captures[0].headers.authorization).toBe("Bearer openai-secret");
    expect(captures[0].headers["anthropic-version"]).toBeUndefined();
    expect(captures[0].headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(captures[0].body)).toMatchObject({
      model: "gpt-5.5",
      max_output_tokens: 100,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }]
    });

    const count = await postClaudeMessage(app.url, "/anthropic/v1/messages/count_tokens", {
      model: "claude-opus-4-8",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "count me" }]
    });
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ input_tokens: 33 });
    expect(captures[1].url).toBe("/v1/responses/input_tokens");
    const countBody = JSON.parse(captures[1].body);
    expect(countBody.max_output_tokens).toBeUndefined();
    expect(countBody.stream).toBeUndefined();
  });

  it("streams Anthropic events to the client before the OpenAI upstream closes", async () => {
    let releaseUpstream: (() => void) | null = null;
    const upstream = await startCapturedOpenAiUpstream([], async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event("response.created", {
        type: "response.created",
        response: { id: "resp_live", model: "gpt-5.5", output: [], usage: { input_tokens: 2, output_tokens: 0 } }
      }));
      res.write(event("response.output_text.delta", {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "live"
      }));
      await new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      res.end(event("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_live",
          status: "completed",
          model: "gpt-5.5",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "live" }]
          }],
          usage: { input_tokens: 2, output_tokens: 1 }
        }
      }));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: upstream.url,
          upstream_protocol: "openai_responses",
          model_override: "gpt-5.5"
        }
      }
    });
    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      stream: true,
      messages: [{ role: "user", content: "stream" }]
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain("message_start");
    const release = releaseUpstream as (() => void) | null;
    release?.();
    const chunks = [first.value ?? new Uint8Array()];
    while (true) {
      const next = await reader!.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
    expect(text).toContain("text_delta");
    expect(text.match(/message_stop/g)).toHaveLength(2);
  });
});

function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data ? [JSON.parse(data) as Record<string, unknown>] : [];
    });
}
