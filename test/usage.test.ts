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
      additiveCachedInputTokens: false,
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
      cacheReadInputTokens: 158_144,
      cacheCreationInputTokens: null,
      additiveCachedInputTokens: true,
      totalTokens: 158_290
    });
  });

  it("counts Anthropic nested cache creation tokens alongside uncached input tokens", () => {
    const usage = extractResponseUsage(
      Buffer.from(JSON.stringify({
        usage: {
          input_tokens: 24,
          output_tokens: 64,
          cache_read_input_tokens: 576,
          cache_creation: {
            ephemeral_5m_input_tokens: 11,
            ephemeral_1h_input_tokens: 13
          }
        }
      })),
      { "content-type": "application/json" }
    );

    expect(usage).toMatchObject({
      inputTokens: 24,
      outputTokens: 64,
      cachedInputTokens: 600,
      cacheReadInputTokens: 576,
      cacheCreationInputTokens: 24,
      additiveCachedInputTokens: true,
      totalTokens: 688
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
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 4,
      additiveCachedInputTokens: true,
      totalTokens: 83
    });
  });

  it("preserves streamed Claude input/cache split when later frames collapse cache input", () => {
    const start = JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 11,
          cache_read_input_tokens: 28_032,
          output_tokens: 1
        }
      }
    });
    const delta = JSON.stringify({
      type: "message_delta",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 28_043,
        output_tokens: 69,
        output_tokens_details: {
          reasoning_tokens: 29
        }
      }
    });

    const usage = extractResponseUsage(
      Buffer.from(`event: message_start\ndata: ${start}\n\nevent: message_delta\ndata: ${delta}\n\n`),
      { "content-type": "text/event-stream" }
    );

    expect(usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 69,
      cachedInputTokens: 28_032,
      cacheReadInputTokens: 28_032,
      cacheCreationInputTokens: null,
      reasoningTokens: 29,
      additiveCachedInputTokens: true,
      totalTokens: 28_112
    });
  });

  it("separates Claude cache creation from cache read when request input is reported as zero", () => {
    const delta = JSON.stringify({
      type: "message_delta",
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 28_032,
        cache_creation_input_tokens: 11,
        output_tokens: 202,
        output_tokens_details: {
          reasoning_tokens: 159
        }
      }
    });

    const usage = extractResponseUsage(
      Buffer.from(`event: message_delta\ndata: ${delta}\n\n`),
      { "content-type": "text/event-stream" }
    );

    expect(usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 202,
      cachedInputTokens: 28_043,
      cacheReadInputTokens: 28_032,
      cacheCreationInputTokens: 11,
      reasoningTokens: 159,
      additiveCachedInputTokens: true,
      totalTokens: 28_245
    });
  });

  it("normalizes OpenAI-compatible prompt cache hit and miss aliases", () => {
    const usage = extractResponseUsage(
      Buffer.from(JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: "123",
          completion_tokens: 45,
          total_tokens: 168,
          prompt_cache_hit_tokens: 100,
          prompt_cache_miss_tokens: 23
        }
      })),
      { "content-type": "application/json" }
    );

    expect(usage).toMatchObject({
      inputTokens: 123,
      outputTokens: 45,
      cachedInputTokens: 100,
      additiveCachedInputTokens: false,
      totalTokens: 168
    });
  });

  it("normalizes camelCase usage aliases returned by compatibility gateways", () => {
    const usage = extractResponseUsage(
      Buffer.from(JSON.stringify({
        response: {
          usage: {
            inputTokens: 31,
            outputTokens: 9,
            cacheReadTokens: 12,
            cacheCreationTokens: 5,
            reasoningTokens: 7,
            totalTokens: 57
          }
        }
      })),
      { "content-type": "application/json" }
    );

    expect(usage).toMatchObject({
      inputTokens: 31,
      outputTokens: 9,
      cachedInputTokens: 17,
      cacheReadInputTokens: 12,
      cacheCreationInputTokens: 5,
      reasoningTokens: 7,
      additiveCachedInputTokens: true,
      totalTokens: 57
    });
  });

  it("normalizes Gemini usageMetadata fields nested in raw gateway responses", () => {
    const usage = extractResponseUsage(
      Buffer.from(JSON.stringify({
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 30,
          thoughtsTokenCount: 50,
          totalTokenCount: 170
        }
      })),
      { "content-type": "application/json" }
    );

    expect(usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 70,
      cachedInputTokens: 30,
      reasoningTokens: 50,
      additiveCachedInputTokens: false,
      totalTokens: 170
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
