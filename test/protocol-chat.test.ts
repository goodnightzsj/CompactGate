import { describe, expect, it } from "vitest";
import {
  anthropicRequestToChat,
  chatCompletionToAnthropic,
  chatCompletionToResponsesCompaction,
  chatCompletionToResponses,
  decodeCompactGateCompactionSummary,
  responsesRemoteV2CompactionToChat,
  responsesRequestToChat
} from "../src/server/protocol-conversion.js";
import {
  createChatToResponsesStream
} from "../src/server/protocol-stream.js";
import {
  type CapturedRequest,
  postJson,
  startApp,
  startCapturedOpenAiUpstream
} from "./helpers/server-test-utils.js";
import { postClaudeMessage } from "./server-claude-core-helpers.js";

describe("OpenAI Chat upstream conversion", () => {
  it("turns a Remote V2 trigger into an ordinary summary prompt and signs the response", () => {
    const converted = responsesRemoteV2CompactionToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      stream: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "context" }] },
        { type: "compaction_trigger" }
      ]
    })));
    const request = JSON.parse(converted.toString("utf8"));
    expect(request.stream).toBeUndefined();
    expect(request.messages.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("summary text only")
    });

    const response = chatCompletionToResponsesCompaction(Buffer.from(JSON.stringify({
      id: "chat-compaction",
      model: "gpt-5.5-chat",
      choices: [{
        message: { role: "assistant", content: "signed summary" },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    })), 200);
    const body = JSON.parse(response.toString("utf8"));
    expect(body.object).toBe("response.compaction");
    expect(decodeCompactGateCompactionSummary(body.output[0].encrypted_content)).toBe("signed summary");
  });
  it("maps supported Responses input and function tools to Chat", () => {
    const converted = responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      instructions: "Be concise.",
      max_output_tokens: 2048,
      stream: true,
      tools: [{
        type: "function",
        name: "weather",
        description: "Read weather",
        parameters: { type: "object", properties: { city: { type: "string" } } }
      }],
      tool_choice: { type: "function", name: "weather" },
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Weather?" },
            { type: "input_image", image_url: "https://example.com/weather.png" }
          ]
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: "{\"city\":\"Shanghai\"}"
        },
        { type: "function_call_output", call_id: "call_1", output: "sunny" }
      ]
    })));
    const body = JSON.parse(converted.toString("utf8"));

    expect(body).toMatchObject({
      model: "gpt-5.5-chat",
      max_completion_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: { type: "function", function: { name: "weather" } },
      tools: [{
        type: "function",
        function: {
          name: "weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }]
    });
    expect(body.messages).toEqual([
      { role: "developer", content: "Be concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "Weather?" },
          { type: "image_url", image_url: { url: "https://example.com/weather.png" } }
        ]
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "weather", arguments: "{\"city\":\"Shanghai\"}" }
        }]
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" }
    ]);
  });

  it("carries a configured reasoning effort into the Chat request instead of rejecting it", () => {
    // rewritePrimaryBody injects `reasoning: {effort}` from primary.reasoning_effort
    // for every /responses request, so rejecting the field outright made
    // CompactGate fail its own request before reaching the upstream.
    const body = JSON.parse(responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: "hello",
      reasoning: { effort: "high" }
    }))).toString("utf8"));

    expect(body).toMatchObject({ model: "gpt-5.5", reasoning_effort: "high" });
    expect(body.reasoning).toBeUndefined();
  });

  it("translates a Responses reasoning object by keeping the effort and dropping its siblings", () => {
    // Requiring a lone `effort` key meant the carve-out never matched real
    // traffic: Codex sends `{context, effort}` on 100% of requests and this
    // module's own Anthropic→Responses step emits `{effort, summary}`, so both
    // fell through to the blanket rejection and every request 422'd. Nothing Chat
    // accepts can express either sibling, so dropping them is the translation.
    expect(JSON.parse(responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: "hello",
      reasoning: { effort: "high", summary: "detailed" }
    }))).toString("utf8"))).toMatchObject({ reasoning_effort: "high" });

    expect(JSON.parse(responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: "hello",
      reasoning: { effort: "medium", context: "prior-turn" }
    }))).toString("utf8"))).toMatchObject({ reasoning_effort: "medium" });

    // An object carrying no effort at all still has nothing to translate.
    expect(() => responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5",
      input: "hello",
      reasoning: { summary: "detailed" }
    })))).toThrow(/cannot be translated to OpenAI Chat/);
  });

  it("still produces compaction state when the summary hits the token ceiling", () => {
    // finish_reason "length" makes chatCompletionToResponses report status
    // "incomplete". Bailing out returned a plain Responses body that the caller
    // then wrapped in compaction events and announced as completed, so the turn
    // lost its summary with no error anywhere.
    const converted = chatCompletionToResponsesCompaction(Buffer.from(JSON.stringify({
      id: "chatcmpl_truncated",
      model: "gpt-5.5-chat",
      choices: [{
        index: 0,
        finish_reason: "length",
        message: { role: "assistant", content: "Partial summary of the work so far" }
      }]
    })), 200);
    const body = JSON.parse(converted.toString("utf8"));

    expect(body.object).toBe("response.compaction");
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe("compaction");
    expect(decodeCompactGateCompactionSummary(body.output[0].encrypted_content))
      .toBe("Partial summary of the work so far");
  });

  it("fails loudly when a truncated Chat compaction carries no text at all", () => {
    expect(() => chatCompletionToResponsesCompaction(Buffer.from(JSON.stringify({
      id: "chatcmpl_empty",
      model: "gpt-5.5-chat",
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }]
    })), 200)).toThrow(/did not include summary text/);
  });

  it("flattens Anthropic tool_result blocks into the Chat tool message text", () => {
    // Claude Code always sends tool_result content as a block array, so this is
    // the normal path: stringifying it handed the model raw JSON markup, and an
    // image result inlined a base64 payload billed as text but never seen.
    const chat = JSON.parse(anthropicRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      max_tokens: 900,
      messages: [
        { role: "user", content: [{ type: "text", text: "check" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "line one\nline two" }]
          }]
        }
      ]
    }))).toString("utf8"));

    expect(chat.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "line one\nline two"
    });
  });

  it("names an image tool result instead of inlining its base64", () => {
    const chat = JSON.parse(anthropicRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      max_tokens: 900,
      messages: [
        { role: "user", content: [{ type: "text", text: "shot" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "screenshot", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAABBBBCCCC" }
            }]
          }]
        }
      ]
    }))).toString("utf8"));

    const toolMessage = chat.messages.at(-1) as { content: string };
    expect(toolMessage.content).not.toContain("AAAABBBBCCCC");
    expect(toolMessage.content).toBe("[image]");
  });

  it("maps supported Anthropic Messages input to Chat and translates its stateful features", () => {
    const converted = anthropicRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      system: "Be precise.",
      max_tokens: 900,
      tools: [{
        name: "weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } }
      }],
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "weather", input: { city: "Shanghai" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "sunny" }] }
      ]
    })));
    expect(JSON.parse(converted.toString("utf8"))).toMatchObject({
      model: "gpt-5.5-chat",
      max_completion_tokens: 900,
      messages: [
        { role: "system", content: "Be precise." },
        { role: "user", content: "Weather?" },
        expect.objectContaining({ role: "assistant" }),
        { role: "tool", tool_call_id: "call_1", content: "sunny" }
      ]
    });

    // Thinking now translates instead of failing the request. A budget-based dial
    // becomes the effort tier it corresponds to; refusing it made every Claude Code
    // turn 422 before the upstream was contacted, since Claude Code always sends a
    // thinking block.
    expect(JSON.parse(anthropicRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      thinking: { type: "enabled", budget_tokens: 4096 },
      messages: [{ role: "user", content: "think" }]
    }))).toString("utf8"))).toMatchObject({ reasoning_effort: "medium" });

    // A prior reasoning item carries provider-encrypted state that Chat has no
    // field for, so it is dropped rather than refused — which is also what the
    // client's own `context_management: clear_thinking` directive asks for. The
    // surrounding turn still has to survive.
    expect(JSON.parse(responsesRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      input: [
        { type: "reasoning", encrypted_content: "state" },
        { type: "message", role: "user", content: "after" }
      ]
    }))).toString("utf8"))).toMatchObject({
      messages: [{ role: "user", content: "after" }]
    });
    expect(() => anthropicRequestToChat(Buffer.from(JSON.stringify({
      model: "gpt-5.5-chat",
      messages: [{ role: "user", content: "count" }]
    })), { countTokens: true })).toThrow("does not provide an Anthropic count_tokens equivalent");
  });

  it("maps Chat JSON output to Responses and Anthropic contracts", () => {
    const chat = Buffer.from(JSON.stringify({
      id: "chatcmpl_json",
      object: "chat.completion",
      created: 1_787_000_000,
      model: "gpt-5.5-chat",
      choices: [{
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Calling weather.",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: "{\"city\":\"Shanghai\"}" }
          }]
        }
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
        prompt_tokens_details: { cached_tokens: 3 }
      }
    }));

    expect(JSON.parse(chatCompletionToResponses(chat, 200).toString("utf8"))).toMatchObject({
      id: "chatcmpl_json",
      object: "response",
      status: "completed",
      output_text: "Calling weather.",
      output: [
        expect.objectContaining({ type: "message" }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: "{\"city\":\"Shanghai\"}"
        })
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        total_tokens: 19,
        input_tokens_details: { cached_tokens: 3 }
      }
    });
    expect(JSON.parse(chatCompletionToAnthropic(chat, 200).toString("utf8"))).toMatchObject({
      type: "message",
      model: "gpt-5.5-chat",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Calling weather." },
        { type: "tool_use", id: "call_1", name: "weather", input: { city: "Shanghai" } }
      ],
      // OpenAI's input_tokens covers the whole prompt, so the 3 cached tokens
      // come out of the fresh Anthropic input: 9 + 3 + 7 = the stated total 19.
      usage: { input_tokens: 9, output_tokens: 7, cache_read_input_tokens: 3 }
    });
    expect(JSON.parse(chatCompletionToAnthropic(Buffer.from(JSON.stringify({
      error: { type: "invalid_request_error", message: "bad input" }
    })), 400).toString("utf8"))).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "bad input" }
    });
  });

  it("converts fragmented Chat SSE to one complete Responses stream", async () => {
    const transform = createChatToResponsesStream();
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    const source = [
      chatEvent({
        id: "chatcmpl_stream",
        object: "chat.completion.chunk",
        created: 1_787_000_000,
        model: "gpt-5.5-chat",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }]
      }),
      chatEvent({
        id: "chatcmpl_stream",
        object: "chat.completion.chunk",
        created: 1_787_000_000,
        model: "gpt-5.5-chat",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "weather", arguments: "{\"city\":" }
            }]
          },
          finish_reason: null
        }]
      }),
      chatEvent({
        id: "chatcmpl_stream",
        object: "chat.completion.chunk",
        created: 1_787_000_000,
        model: "gpt-5.5-chat",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "\"Shanghai\"}" } }] },
          finish_reason: "tool_calls"
        }]
      }),
      chatEvent({
        id: "chatcmpl_stream",
        object: "chat.completion.chunk",
        created: 1_787_000_000,
        model: "gpt-5.5-chat",
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
      }),
      "data: [DONE]\n\n"
    ].join("");
    for (let offset = 0; offset < source.length; offset += 7) {
      transform.write(source.slice(offset, offset + 7));
    }
    transform.end();
    await finished(transform);

    const events = parseEvents(Buffer.concat(chunks).toString("utf8"));
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "response.output_text.delta", delta: "Hello" }),
      expect.objectContaining({ type: "response.function_call_arguments.delta", delta: "{\"city\":" }),
      expect.objectContaining({ type: "response.function_call_arguments.delta", delta: "\"Shanghai\"}" })
    ]));
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        id: "chatcmpl_stream",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 }
      }
    });
  });

  it("proxies both client protocols through a Chat upstream", async () => {
    const captures: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(captures, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_proxy",
        object: "chat.completion",
        created: 1_787_000_000,
        model: "gpt-5.5-chat",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "proxied" }
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }));
    });
    const app = await startApp(upstream.url, undefined, {
      primary: {
        upstream_protocol: "openai_chat",
        api_key: "chat-primary-secret",
        model_override: "gpt-5.5-chat"
      },
      claude: {
        primary: {
          base_url: upstream.url,
          upstream_protocol: "openai_chat",
          api_key: "chat-claude-secret",
          model_override: "gpt-5.5-chat"
        }
      }
    });

    const codex = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "hello"
    }, {
      "x-codex-beta-features": "remote_compaction_v2"
    });
    expect(codex.status).toBe(200);
    expect(await codex.json()).toMatchObject({
      object: "response",
      output_text: "proxied",
      usage: { input_tokens: 3, output_tokens: 2 }
    });

    const claude = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }]
    });
    expect(claude.status).toBe(200);
    expect(await claude.json()).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "proxied" }],
      usage: { input_tokens: 3, output_tokens: 2 }
    });

    expect(captures).toHaveLength(2);
    expect(captures[0].url).toBe("/v1/chat/completions");
    expect(captures[0].headers.authorization).toBe("Bearer chat-primary-secret");
    expect(captures[0].headers["accept-encoding"]).toBe("identity");
    expect(captures[0].headers["x-codex-beta-features"]).toBeUndefined();
    expect(JSON.parse(captures[0].body)).toMatchObject({
      model: "gpt-5.5-chat",
      messages: [{ role: "user", content: "hello" }]
    });
    expect(captures[1].url).toBe("/v1/chat/completions");
    expect(captures[1].headers.authorization).toBe("Bearer chat-claude-secret");
    expect(captures[1].headers["accept-encoding"]).toBe("identity");
    expect(captures[1].headers["anthropic-version"]).toBeUndefined();
    expect(JSON.parse(captures[1].body)).toMatchObject({
      model: "gpt-5.5-chat",
      max_completion_tokens: 100,
      messages: [{ role: "user", content: "hello" }]
    });
  });

  it("synthesizes Chat Remote V2 compaction and accepts only CompactGate state on follow-up", async () => {
    const captures: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(captures, async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chat-compaction-proxy",
        model: "gpt-5.5-chat",
        choices: [{
          message: { role: "assistant", content: "Chat portable summary." },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }
      }));
    });
    const app = await startApp(upstream.url, undefined, {
      primary: {
        upstream_protocol: "openai_chat",
        api_key: "chat-primary-secret",
        model_override: "gpt-5.5-chat"
      }
    });
    const metadata = JSON.stringify({
      request_kind: "compaction",
      compaction: { implementation: "responses_compaction_v2" }
    });

    const trigger = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      stream: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "context" }] },
        { type: "compaction_trigger" }
      ]
    }, { "x-codex-turn-metadata": metadata });
    expect(trigger.status).toBe(200);
    expect(trigger.headers.get("content-type")).toContain("text/event-stream");
    const triggerText = await trigger.text();
    expect(triggerText).toContain("response.output_item.done");
    const state = triggerText.match(/"encrypted_content":"(cg1_[^"]+)"/)?.[1];
    expect(state).toMatch(/^cg1_/);
    expect(JSON.parse(captures[0].body).messages.at(-1).content).toContain("summary text only");

    const followUp = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        { type: "compaction", encrypted_content: state },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
      ]
    });
    expect(followUp.status).toBe(200);
    expect(await followUp.json()).toMatchObject({ output_text: "Chat portable summary." });
    expect(captures).toHaveLength(2);

    const opaque = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [{ type: "compaction", encrypted_content: "provider-owned" }]
    });
    expect(opaque.status).toBe(422);
    expect(await opaque.json()).toMatchObject({
      error: expect.stringContaining("opaque compaction state")
    });
    expect(captures).toHaveLength(2);
  });

  it("streams Chat output to Anthropic before the upstream closes", async () => {
    let releaseUpstream: (() => void) | null = null;
    const upstream = await startCapturedOpenAiUpstream([], (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatEvent({
        id: "chatcmpl_live",
        object: "chat.completion.chunk",
        created: 1_787_000_000,
        model: "gpt-5.5-chat",
        choices: [{ index: 0, delta: { role: "assistant", content: "live" }, finish_reason: null }]
      }));
      return new Promise<void>((resolve) => {
        releaseUpstream = () => {
          res.write(chatEvent({
            id: "chatcmpl_live",
            object: "chat.completion.chunk",
            created: 1_787_000_000,
            model: "gpt-5.5-chat",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          }));
          res.end("data: [DONE]\n\n");
          resolve();
        };
      });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: upstream.url,
          upstream_protocol: "openai_chat",
          api_key: "chat-secret",
          model_override: "gpt-5.5-chat"
        }
      }
    });

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "stream" }]
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    const firstText = new TextDecoder().decode(first?.value);
    expect(firstText).toContain("message_start");
    (releaseUpstream as (() => void) | null)?.();
    let remainder = "";
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += new TextDecoder().decode(chunk.value);
    }
    expect(`${firstText}${remainder}`).toContain("live");
    expect(`${firstText}${remainder}`).toContain("message_stop");
  });

  it("streams Chat output to Codex before the upstream closes", async () => {
    let releaseUpstream: (() => void) | null = null;
    const upstream = await startCapturedOpenAiUpstream([], (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatEvent({
        id: "chatcmpl_codex_live",
        object: "chat.completion.chunk",
        created: 1_787_000_000,
        model: "gpt-5.5-chat",
        choices: [{ index: 0, delta: { role: "assistant", content: "live" }, finish_reason: null }]
      }));
      return new Promise<void>((resolve) => {
        releaseUpstream = () => {
          res.write(chatEvent({
            id: "chatcmpl_codex_live",
            object: "chat.completion.chunk",
            created: 1_787_000_000,
            model: "gpt-5.5-chat",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
          }));
          res.end("data: [DONE]\n\n");
          resolve();
        };
      });
    });
    const app = await startApp(upstream.url, undefined, {
      primary: {
        upstream_protocol: "openai_chat",
        api_key: "chat-secret",
        model_override: "gpt-5.5-chat"
      }
    });

    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "stream",
      stream: true
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    let firstText = "";
    try {
      const first = await reader?.read();
      firstText = new TextDecoder().decode(first?.value);
      expect(firstText).toContain("response.created");
      expect(firstText).toContain("live");
    } finally {
      (releaseUpstream as (() => void) | null)?.();
    }
    let remainder = "";
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += new TextDecoder().decode(chunk.value);
    }
    expect(`${firstText}${remainder}`).toContain("response.completed");
  });
});

function chatEvent(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

function parseEvents(source: string): Array<Record<string, unknown>> {
  return source.split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data) as Record<string, unknown>];
  });
}

function finished(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}
