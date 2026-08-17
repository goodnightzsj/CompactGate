import { describe, expect, it } from "vitest";
import {
  anthropicMessageToResponsesCompaction,
  decodeCompactGateCompactionSummary,
  encodeCompactGateCompactionSummary,
  responsesCompactRequestToAnthropic
} from "../src/server/protocol-conversion.js";
import {
  createAnthropicToResponsesCompactionStream
} from "../src/server/protocol-stream.js";
import {
  CompactionBridgeStore,
  UnresolvedCompactionStateError
} from "../src/server/compaction-bridge.js";
import { buildPrimaryOpenAiProxyPlan } from "../src/server/openai-proxy-plan.js";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import {
  captureRequest,
  type CapturedRequest,
  postJson,
  startApp,
  startClaudeUpstream
} from "./helpers/server-test-utils.js";

describe("cross-protocol compaction", () => {
  it("translates a remote V1 compact request to native Messages context management", () => {
    const converted = responsesCompactRequestToAnthropic(Buffer.from(JSON.stringify({
      model: "claude-opus-5",
      stream: true,
      input: [{
        type: "compaction_trigger",
        content: [{ type: "input_text", text: "summarize this conversation" }]
      }]
    })));
    const body = JSON.parse(converted.body.toString("utf8"));

    expect(converted.stream).toBe(true);
    expect(body).toMatchObject({
      model: "claude-opus-5",
      messages: [{ role: "user", content: [{ type: "text", text: "summarize this conversation" }] }],
      context_management: {
        edits: [{
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 50000 },
          pause_after_compaction: true
        }]
      }
    });
    expect(body.messages[0].content).not.toContainEqual({ type: "compaction_trigger" });
  });

  it("converts a native JSON compaction block into restart-safe CompactGate state", () => {
    const converted = anthropicMessageToResponsesCompaction(Buffer.from(JSON.stringify({
      id: "msg_compact",
      type: "message",
      model: "claude-opus-5",
      stop_reason: "compaction",
      content: [{ type: "compaction", content: "Keep the implementation plan." }],
      usage: { input_tokens: 100, output_tokens: 20 }
    })), 200);
    const body = JSON.parse(converted.toString("utf8"));
    const state = body.output[0].encrypted_content as string;

    expect(body).toMatchObject({
      id: "msg_compact",
      object: "response.compaction",
      output: [{ type: "compaction" }],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
    });
    expect(state).toMatch(/^cg1_/);
    expect(decodeCompactGateCompactionSummary(state)).toBe("Keep the implementation plan.");
  });

  it("rejects native compaction responses without a readable block", () => {
    expect(() => anthropicMessageToResponsesCompaction(Buffer.from(JSON.stringify({
      id: "msg_empty",
      type: "message",
      content: [{ type: "compaction", content: null }]
    })), 200)).toThrow("did not include a readable compaction block");
  });

  it("converts fragmented native compaction SSE with one terminal event", async () => {
    const transform = createAnthropicToResponsesCompactionStream();
    const chunks: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk));
    const source = [
      event("message_start", {
        type: "message_start",
        message: {
          id: "msg_compact_stream",
          model: "claude-opus-5",
          usage: { input_tokens: 40, output_tokens: 0 }
        }
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "compaction", content: null }
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "compaction_delta", content: "Streamed " }
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "compaction_delta", content: "summary." }
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "compaction" },
        usage: { output_tokens: 9 }
      }),
      event("message_stop", { type: "message_stop" })
    ].join("");

    for (let offset = 0; offset < source.length; offset += 5) {
      transform.write(source.slice(offset, offset + 5));
    }
    transform.end();
    await new Promise<void>((resolve, reject) => {
      transform.once("end", resolve);
      transform.once("error", reject);
    });

    const events = parseEvents(Buffer.concat(chunks).toString("utf8"));
    const completed = events.filter((item) => item.type === "response.completed");
    expect(completed).toHaveLength(1);
    expect(events.filter((item) => item.type === "response.failed")).toHaveLength(0);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "response.output_item.done", item: expect.objectContaining({ type: "compaction" }) })
    ]));
    const state = events.find((item) => item.type === "response.output_item.done")
      ?.item as { encrypted_content?: string } | undefined;
    expect(decodeCompactGateCompactionSummary(state?.encrypted_content)).toBe("Streamed summary.");
    expect(completed[0]).toMatchObject({
      response: {
        id: "msg_compact_stream",
        object: "response.compaction",
        output: [{ type: "compaction" }],
        usage: { input_tokens: 40, output_tokens: 9, total_tokens: 49 }
      }
    });
  });

  it("rewrites portable state after a fresh bridge instance without readable fallback", () => {
    const encoded = encodeCompactGateCompactionSummary("Portable summary survives restart.");
    const bridge = new CompactionBridgeStore();
    const result = bridge.rewritePrimaryBody(
      Buffer.from(JSON.stringify({
        model: "gpt-5.5",
        input: [{ type: "compaction", encrypted_content: encoded }]
      })),
      { compactUpstream: "http://compact.example", sourceModel: "gpt-5.5", targetModel: "gpt-5.5" },
      { includeStandardFallbacks: false, includeSyntheticFallbacks: false, allowReadableFallback: false }
    );

    expect(result.replacedCompactionCount).toBe(1);
    expect(result.remainingCompactionCount).toBe(0);
    expect(JSON.parse(result.body.toString("utf8")).input).toEqual([{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Portable summary survives restart." }]
    }]);
  });

  it("rejects opaque state before an Anthropic primary request", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.primary.upstream_protocol = "anthropic_messages";
    config.compact.upstream_mode = "split";
    expect(() => buildPrimaryOpenAiProxyPlan({
      config,
      url: new URL("http://compactgate.local/v1/responses"),
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from(JSON.stringify({
        model: "gpt-5.5",
        input: [{ type: "compaction", encrypted_content: "provider-owned" }]
      })),
      endpoint: "/responses",
      compactionBridge: new CompactionBridgeStore(),
      primaryFailover: new PrimaryFailoverState({ random: () => 0 })
    })).toThrow(UnresolvedCompactionStateError);
  });

  it("proxies remote V1 compaction through Anthropic Messages and disables raw dedupe", async () => {
    const captures: CapturedRequest[] = [];
    const upstream = await startClaudeUpstream(async (req, res) => {
      captures.push(await captureRequest(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_compact_proxy",
        type: "message",
        model: "claude-opus-5",
        stop_reason: "compaction",
        content: [{ type: "compaction", content: "Proxy summary." }],
        usage: { input_tokens: 30, output_tokens: 8 }
      }));
    });
    const app = await startApp("http://127.0.0.1:1/v1", upstream.url, {
      compact: {
        upstream_protocol: "anthropic_messages",
        model_template: "{model}"
      }
    });

    const body = { model: "claude-opus-5", input: "compact me" };
    const first = await postJson(app.url, "/v1/responses/compact", body);
    const second = await postJson(app.url, "/v1/responses/compact", body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json() as { object: string; output: Array<{ encrypted_content: string }> };
    await second.text();

    expect(firstBody.object).toBe("response.compaction");
    expect(decodeCompactGateCompactionSummary(firstBody.output[0].encrypted_content)).toBe("Proxy summary.");
    expect(captures).toHaveLength(2);
    expect(captures[0].url).toBe("/v1/messages");
    expect(captures[0].headers["anthropic-beta"]).toContain("compact-2026-01-12");
    expect(JSON.parse(captures[0].body)).toMatchObject({
      model: "claude-opus-5",
      context_management: { edits: [{ type: "compact_20260112" }] }
    });
  });

  it("translates remote V2 trigger and portable follow-up on an Anthropic primary", async () => {
    const captures: CapturedRequest[] = [];
    const upstream = await startClaudeUpstream(async (req, res) => {
      const captured = await captureRequest(req);
      captures.push(captured);
      const body = JSON.parse(captured.body) as { context_management?: unknown };
      if (body.context_management) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(event("message_start", {
          type: "message_start",
          message: { id: "msg_v2_compact", model: "claude-opus-5", usage: { input_tokens: 50, output_tokens: 0 } }
        }));
        res.write(event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "compaction", content: null }
        }));
        res.write(event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "compaction_delta", content: "V2 portable summary." }
        }));
        res.write(event("content_block_stop", { type: "content_block_stop", index: 0 }));
        res.end(event("message_stop", { type: "message_stop" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_follow_up",
        type: "message",
        model: "claude-opus-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "continued" }]
      }));
    });
    const app = await startApp(upstream.url, "http://127.0.0.1:1/v1", {
      primary: { upstream_protocol: "anthropic_messages", model_override: "claude-opus-5" }
    });
    const metadata = JSON.stringify({
      request_kind: "compaction",
      compaction: { implementation: "responses_compaction_v2" }
    });
    const trigger = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      stream: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "compact this" }] },
        { type: "compaction_trigger" }
      ]
    }, { "x-codex-turn-metadata": metadata });
    expect(trigger.status).toBe(200);
    const triggerText = await trigger.text();
    const state = parseEvents(triggerText).find((item) => item.type === "response.output_item.done")
      ?.item as { encrypted_content?: string } | undefined;
    expect(state?.encrypted_content).toMatch(/^cg1_/);
    const encryptedContent = state?.encrypted_content;
    if (!encryptedContent) {
      throw new Error("Expected translated remote V2 compaction state.");
    }

    const followUp = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: [
        { type: "compaction", encrypted_content: encryptedContent },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
      ]
    }, { "x-codex-beta-features": "remote_compaction_v2" });
    expect(followUp.status).toBe(200);
    expect(await followUp.json()).toMatchObject({ output_text: "continued" });
    expect(captures).toHaveLength(2);
    expect(captures[0].url).toBe("/v1/messages");
    expect(captures[1].url).toBe("/v1/messages");
    expect(JSON.parse(captures[1].body).messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "V2 portable summary." }] },
      { role: "user", content: [{ type: "text", text: "continue" }] }
    ]);
  });
});

function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseEvents(text: string): Array<Record<string, unknown> & { item?: unknown }> {
  return text
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return data ? [JSON.parse(data) as Record<string, unknown> & { item?: unknown }] : [];
    });
}
