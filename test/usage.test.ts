import { describe, expect, it } from "vitest";
import { extractRequestMetadata, extractResponseUsage } from "../src/server/usage.js";

describe("usage metadata extraction", () => {
  it("keeps OpenAI-style cached input as an input token subset", () => {
    const usage = extractResponseUsage(
      Buffer.from(JSON.stringify({
        usage: {
          input_tokens: 110,
          output_tokens: 36,
          input_tokens_details: {
            cached_tokens: 90
          }
        }
      })),
      { "content-type": "application/json" }
    );

    expect(usage).toMatchObject({
      inputTokens: 110,
      outputTokens: 36,
      cachedInputTokens: 90,
      totalTokens: 146
    });
  });

  it("counts Anthropic-style cache read tokens alongside uncached input tokens", () => {
    const usage = extractResponseUsage(
      Buffer.from(JSON.stringify({
        usage: {
          input_tokens: 110,
          output_tokens: 36,
          cache_read_input_tokens: 158_144
        }
      })),
      { "content-type": "application/json" }
    );

    expect(usage).toMatchObject({
      inputTokens: 110,
      outputTokens: 36,
      cachedInputTokens: 158_144,
      totalTokens: 158_290
    });
  });

  it("merges streamed Anthropic usage frames without losing additive cache totals", () => {
    const start = JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 42,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 4,
          output_tokens: 1
        }
      }
    });
    const delta = JSON.stringify({
      type: "message_delta",
      usage: {
        output_tokens: 7
      }
    });

    const usage = extractResponseUsage(
      Buffer.from(`event: message_start\ndata: ${start}\n\nevent: message_delta\ndata: ${delta}\n\n`),
      { "content-type": "text/event-stream" }
    );

    expect(usage).toMatchObject({
      inputTokens: 42,
      outputTokens: 7,
      cachedInputTokens: 34,
      totalTokens: 83
    });
  });

  it("extracts visible Claude thinking effort fields when the request includes them", () => {
    const metadata = extractRequestMetadata(
      "/v1/messages",
      Buffer.from(JSON.stringify({
        stream: true,
        thinking: {
          type: "enabled",
          effort: "xhigh",
          budget_tokens: 32_000,
          display: "adaptive"
        },
        messages: [{ role: "user", content: "hello" }]
      }))
    );

    expect(metadata.reasoningEffort).toBe("xhigh");
    expect(metadata.requestSummary).toContain("thinking xhigh");
  });

  it("falls back to the visible Anthropic thinking type when CLI effort is not present", () => {
    const metadata = extractRequestMetadata(
      "/v1/messages",
      Buffer.from(JSON.stringify({
        stream: true,
        thinking: {
          type: "adaptive"
        },
        messages: [{ role: "user", content: "hello" }]
      }))
    );

    expect(metadata.reasoningEffort).toBe("thinking adaptive");
    expect(metadata.requestSummary).toContain("thinking adaptive");
  });

  it("extracts Claude adaptive thinking effort from output_config", () => {
    const metadata = extractRequestMetadata(
      "/v1/messages",
      Buffer.from(JSON.stringify({
        stream: true,
        thinking: {
          type: "adaptive"
        },
        output_config: {
          effort: "high"
        },
        messages: [{ role: "user", content: "hello" }]
      }))
    );

    expect(metadata.reasoningEffort).toBe("high");
    expect(metadata.requestSummary).toContain("thinking adaptive");
    expect(metadata.requestSummary).toContain("effort high");
  });

  it("recognizes minimal Claude adaptive thinking effort", () => {
    const metadata = extractRequestMetadata(
      "/v1/messages",
      Buffer.from(JSON.stringify({
        stream: true,
        thinking: {
          type: "adaptive"
        },
        output_config: {
          effort: "minimal"
        },
        messages: [{ role: "user", content: "hello" }]
      }))
    );

    expect(metadata.reasoningEffort).toBe("minimal");
    expect(metadata.requestSummary).toContain("effort minimal");
  });
});
