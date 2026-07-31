import { describe, expect, it } from "vitest";
import { buildClaudeUpstreamUrl } from "../src/server/claude-models.js";
import { buildUpstreamUrl } from "../src/server/routing.js";

describe("versioned upstream URL construction", () => {
  it.each([
    ["https://openai.example/v1", "/v1/responses", "https://openai.example/v1/responses"],
    ["https://openai.example/v1/", "/v1/responses", "https://openai.example/v1/responses"],
    [
      "https://openai.example/gateway/v1",
      "/v1/responses",
      "https://openai.example/gateway/v1/responses"
    ],
    [
      "https://open.bigmodel.cn/api/coding/paas/v4",
      "/v1/responses",
      "https://open.bigmodel.cn/api/coding/paas/v4/responses"
    ],
    [
      "https://openai.example/v1",
      "/v10/responses",
      "https://openai.example/v1/v10/responses"
    ]
  ])("replaces the exact OpenAI client API root for %s", (baseUrl, requestPath, expected) => {
    expect(buildUpstreamUrl(baseUrl, requestPath).toString()).toBe(expected);
  });

  it.each([
    ["https://claude.example", "/v1/messages", "https://claude.example/v1/messages"],
    ["https://claude.example/v1", "/v1/messages", "https://claude.example/v1/messages"],
    ["https://claude.example/v1/", "/v1/messages", "https://claude.example/v1/messages"],
    [
      "https://claude.example/anthropic",
      "/v1/messages",
      "https://claude.example/anthropic/v1/messages"
    ],
    [
      "https://claude.example/anthropic/v1",
      "/v1/messages",
      "https://claude.example/anthropic/v1/messages"
    ],
    [
      "https://claude.example/api-v1",
      "/v1/messages",
      "https://claude.example/api-v1/v1/messages"
    ],
    [
      "https://claude.example/v10",
      "/v1/messages",
      "https://claude.example/v10/v1/messages"
    ],
    [
      "https://claude.example/v1",
      "/v1/messages/count_tokens",
      "https://claude.example/v1/messages/count_tokens"
    ]
  ])("appends the Claude request path with exact boundary de-duplication for %s", (baseUrl, requestPath, expected) => {
    expect(buildClaudeUpstreamUrl(baseUrl, requestPath).toString()).toBe(expected);
  });

  it("preserves the Claude beta query while de-duplicating the path", () => {
    expect(
      buildClaudeUpstreamUrl(
        "https://claude.example/v1",
        "/v1/messages",
        "?beta=true"
      ).toString()
    ).toBe("https://claude.example/v1/messages?beta=true");
  });
});
