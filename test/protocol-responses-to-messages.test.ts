import { describe, expect, it } from "vitest";
import {
  anthropicMessageToResponses,
  encodeCompactGateState,
  ProtocolConversionError,
  responsesRequestToAnthropic
} from "../src/server/protocol-conversion.js";
import { createAnthropicToResponsesStream } from "../src/server/protocol-stream.js";
import {
  assertCaptured,
  captureRequest,
  type CapturedRequest,
  postJson,
  startApp,
  startClaudeUpstream
} from "./helpers/server-test-utils.js";

describe("Responses to Anthropic Messages conversion", () => {
  it("maps instructions, messages, images, tools, reasoning, and limits", () => {
    const translated = responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "claude-sonnet-4-5",
      instructions: "Be concise.",
      max_output_tokens: 6000,
      reasoning: { effort: "medium" },
      stream: true,
      tools: [{
        type: "function",
        name: "weather",
        description: "Read weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"]
        }
      }],
      tool_choice: { type: "function", name: "weather" },
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Weather?" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }
          ]
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: "{\"city\":\"Shanghai\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "sunny"
        }
      ]
    })));

    expect(JSON.parse(translated.toString("utf8"))).toEqual({
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "Be concise." }],
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
          content: [{
            type: "tool_use",
            id: "call_1",
            name: "weather",
            input: { city: "Shanghai" }
          }]
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }]
        }
      ],
      tools: [{
        name: "weather",
        description: "Read weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"]
        }
      }],
      tool_choice: { type: "tool", name: "weather" },
      max_tokens: 6000,
      thinking: { type: "enabled", budget_tokens: 4096 },
      stream: true
    });
  });

  it("round-trips CompactGate-owned Anthropic thinking state", () => {
    const translated = responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "claude-sonnet-4-5",
      input: [
        {
          type: "reasoning",
          encrypted_content: encodeCompactGateState({
            kind: "anthropic_thinking",
            thinking: "Check first.",
            signature: "signed-state"
          })
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue." }]
        }
      ]
    })));

    expect(JSON.parse(translated.toString("utf8")).messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Check first.", signature: "signed-state" }]
      },
      { role: "user", content: [{ type: "text", text: "Continue." }] }
    ]);
    expect(() => responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "claude-sonnet-4-5",
      input: [{ type: "reasoning", encrypted_content: "provider-owned" }]
    })))).toThrow("Opaque reasoning state was not created by CompactGate.");
  });

  it("rejects server tools instead of silently dropping them", () => {
    expect(() => responsesRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "claude-sonnet-4-5",
      input: "Search",
      tools: [{ type: "web_search_preview" }]
    })))).toThrowError(ProtocolConversionError);
  });

  it("maps Anthropic JSON messages to Responses output items and usage", () => {
    const converted = anthropicMessageToResponses(Buffer.from(JSON.stringify({
      id: "msg_123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 3
      },
      content: [
        { type: "thinking", thinking: "Check the tool." },
        { type: "text", text: "Calling weather." },
        { type: "tool_use", id: "call_1", name: "weather", input: { city: "Shanghai" } }
      ]
    })), 200);
    const body = JSON.parse(converted.toString("utf8"));

    expect(body).toMatchObject({
      id: "msg_123",
      object: "response",
      status: "completed",
      model: "claude-sonnet-4-5",
      output_text: "Calling weather.",
      usage: {
        // Anthropic's cache_read is additive, so the OpenAI prompt total is
        // 12 + 3 and the grand total 15 + 7.
        input_tokens: 15,
        output_tokens: 7,
        total_tokens: 22,
        input_tokens_details: { cached_tokens: 3 }
      }
    });
    expect(body.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning" }),
      expect.objectContaining({ type: "message", role: "assistant" }),
      expect.objectContaining({
        type: "function_call",
        call_id: "call_1",
        name: "weather",
        arguments: "{\"city\":\"Shanghai\"}"
      })
    ]));
  });

  it("converts fragmented Anthropic SSE into one complete Responses stream", async () => {
    const transform = createAnthropicToResponsesStream();
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));

    const source = [
      event("message_start", {
        type: "message_start",
        message: {
          id: "msg_stream",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          usage: { input_tokens: 5, output_tokens: 0 }
        }
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" }
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "weather", input: {} }
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"city\":\"Shanghai\"}" }
      }),
      event("content_block_stop", { type: "content_block_stop", index: 1 }),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 4 }
      }),
      event("message_stop", { type: "message_stop" })
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
    expect(events.filter((item) => item.type === "response.completed")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "response.output_text.delta", delta: "hello" }),
      expect.objectContaining({
        type: "response.function_call_arguments.delta",
        delta: "{\"city\":\"Shanghai\"}"
      })
    ]));
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        id: "msg_stream",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 }
      }
    });
  });

  it("proxies a Codex JSON request through an Anthropic Messages upstream", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const upstream = await startClaudeUpstream(async (req, res) => {
      captured.current = await captureRequest(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_proxy",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "proxied" }],
        usage: { input_tokens: 3, output_tokens: 2 }
      }));
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, {
      primary: {
        upstream_protocol: "anthropic_messages",
        api_key: "anthropic-secret",
        model_override: "claude-sonnet-4-5"
      }
    });

    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "hello"
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "msg_proxy",
      object: "response",
      status: "completed",
      output_text: "proxied",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
    });
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/messages");
    expect(captured.current.headers["x-api-key"]).toBe("anthropic-secret");
    expect(captured.current.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured.current.headers["x-codex-beta-features"]).toBeUndefined();
    expect(JSON.parse(captured.current.body)).toMatchObject({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 8192
    });
  });

  it("streams translated Responses events before the Anthropic upstream closes", async () => {
    let releaseUpstream: (() => void) | null = null;
    const upstream = await startClaudeUpstream(async (req, res) => {
      await captureRequest(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event("message_start", {
        type: "message_start",
        message: {
          id: "msg_live",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [],
          usage: { input_tokens: 2, output_tokens: 0 }
        }
      }));
      res.write(event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      }));
      res.write(event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "live" }
      }));
      await new Promise<void>((resolve) => {
        releaseUpstream = resolve;
      });
      res.write(event("content_block_stop", { type: "content_block_stop", index: 0 }));
      res.write(event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 }
      }));
      res.end(event("message_stop", { type: "message_stop" }));
    });
    const app = await startApp(`${upstream.url}/v1`, undefined, {
      primary: { upstream_protocol: "anthropic_messages", model_override: "claude-sonnet-4-5" }
    });
    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "stream",
      stream: true
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain("response.created");
    const release = releaseUpstream as (() => void) | null;
    release?.();
    const chunks = [first.value ?? new Uint8Array()];
    while (true) {
      const next = await reader!.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
    expect(text).toContain("response.output_text.delta");
    expect(text.match(/response\.completed/g)).toHaveLength(2);
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
