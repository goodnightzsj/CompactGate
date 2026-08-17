import { describe, expect, it } from "vitest";
import {
  detectClaudeScene,
  hasClaudeImageInput
} from "../src/server/claude-models.js";

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

describe("Claude scene detection", () => {
  it("detects every portable ai-switch scene with stable priority", () => {
    expect(detectClaudeScene(body({
      messages: [{ role: "user", content: "ordinary" }]
    }), "claude-sonnet", 0).scene).toBe("default");

    expect(detectClaudeScene(body({
      messages: [{ role: "user", content: "long enough" }],
      tools: [{ type: "web_search_20250305" }],
      thinking: { type: "enabled" }
    }), "claude-haiku", 4).scene).toBe("long_context");

    expect(detectClaudeScene(body({
      messages: [{ role: "user", content: "background" }],
      tools: [{ type: "web_search_20250305" }]
    }), "claude-haiku-4-5", 0).scene).toBe("background");

    expect(detectClaudeScene(body({
      messages: [{ role: "user", content: "search" }],
      tools: [{ type: "web_search_20250305" }],
      thinking: { type: "enabled" }
    }), "claude-sonnet", 0).scene).toBe("web_search");

    expect(detectClaudeScene(body({
      messages: [{ role: "user", content: [{
        type: "image",
        source: { type: "base64", data: "aGVsbG8=" }
      }]}],
      thinking: { type: "enabled" }
    }), "claude-sonnet", 0).scene).toBe("thinking");

    const imageBody = body({
      messages: [{ role: "user", content: [{
        type: "image",
        source: { type: "base64", data: "x".repeat(10_000) }
      }, { type: "text", text: "look" }] }]
    });
    expect(hasClaudeImageInput(imageBody)).toBe(true);
    expect(detectClaudeScene(imageBody, "claude-sonnet", 100).scene).toBe("image");
  });

  it("counts only textual request context and treats the threshold as inclusive", () => {
    const request = body({
      system: "abc",
      messages: [{ role: "user", content: [{ type: "text", text: "def" }] }],
      tools: [{ name: "tool", description: "ghi", input_schema: { type: "object" } }]
    });
    const detection = detectClaudeScene(request, "claude-sonnet", 13);

    expect(detection.text_bytes).toBe(13);
    expect(detection.scene).toBe("long_context");
  });
});
