import { describe, expect, it } from "vitest";
import {
  detectClaudeScene,
  hasClaudeImageInput,
  resolveClaudeMappedModel,
  rewriteClaudeModelBody
} from "../src/server/claude-models.js";
import { anthropicRequestToResponses } from "../src/server/protocol-conversion.js";

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

describe("Claude model rewrite thinking alignment", () => {
  function rewritten(value: unknown, model: string): Record<string, unknown> {
    return JSON.parse(rewriteClaudeModelBody(body(value), model, true).toString());
  }

  it("translates the reserved budget share into the matching effort tier", () => {
    const cases: Array<[number, number, string]> = [
      [31999, 32000, "max"],
      [16000, 32000, "high"],
      [8000, 32000, "medium"],
      [1024, 32000, "low"]
    ];

    for (const [budget, maxTokens, effort] of cases) {
      const result = rewritten({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: maxTokens,
        thinking: { type: "enabled", budget_tokens: budget }
      }, "claude-opus-5");

      expect(result.model).toBe("claude-opus-5");
      expect(result.thinking).toEqual({ type: "adaptive" });
      expect(result.output_config).toEqual({ effort });
    }
  });

  it("leaves thinking untouched when the client already speaks the target dialect", () => {
    const passthrough = rewritten({
      model: "claude-opus-4-8",
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" }
    }, "claude-opus-5");
    expect(passthrough.thinking).toEqual({ type: "adaptive" });
    expect(passthrough.output_config).toEqual({ effort: "low" });

    const disabled = rewritten({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 32000,
      thinking: { type: "disabled" }
    }, "claude-opus-5");
    expect(disabled.thinking).toEqual({ type: "disabled" });
    expect(disabled.output_config).toBeUndefined();

    const budgetTarget = rewritten({
      model: "claude-opus-4-8",
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 31999 }
    }, "claude-sonnet-4-5-20250929");
    expect(budgetTarget.thinking).toEqual({ type: "enabled", budget_tokens: 31999 });
    expect(budgetTarget.output_config).toBeUndefined();
  });

  it("never injects output_config when alignment is off, so protocol conversion stays reachable", () => {
    const converted = JSON.parse(rewriteClaudeModelBody(body({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      messages: [{ role: "user", content: "hi" }]
    }), "claude-opus-5").toString());

    expect(converted.model).toBe("claude-opus-5");
    expect(converted.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    expect(converted.output_config).toBeUndefined();
    expect(() => anthropicRequestToResponses(Buffer.from(JSON.stringify(converted)), {
      countTokens: false
    })).not.toThrow();
  });

  it("translates an effort tier back into a budget for a budget-based target", () => {
    const cases: Array<[string, number]> = [
      ["max", 31999],
      ["high", 20000],
      ["medium", 12000],
      ["low", 4800]
    ];

    for (const [effort, budget] of cases) {
      const result = rewritten({
        model: "claude-opus-4-8",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        output_config: { effort }
      }, "claude-sonnet-4-5-20250929");

      expect(result.thinking).toEqual({ type: "enabled", budget_tokens: budget });
      expect(result.output_config).toBeUndefined();
    }
  });

  it("keeps a bare adaptive request usable on a budget-based target", () => {
    const result = rewritten({
      model: "claude-opus-4-8",
      max_tokens: 32000,
      thinking: { type: "adaptive" }
    }, "claude-sonnet-4-5-20250929");

    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 31999 });
  });

  it("drops thinking instead of emitting a budget above max_tokens", () => {
    // Anthropic wants budget_tokens >= 1024 and < max_tokens, so a small output
    // ceiling satisfies neither. Clamping to the 1024 floor anyway sent
    // budget_tokens: 1024 with max_tokens: 512 and the upstream 400'd the whole
    // request — a subagent probe asking for a short answer would just fail.
    for (const maxTokens of [512, 1000, 1024]) {
      const result = rewritten({
        model: "claude-opus-4-8",
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" }
      }, "claude-sonnet-4-5-20250929");

      // Both the budget *and* the client's own adaptive block have to go: a
      // budget-based target 400s on `{type:"adaptive"}` just as it does on a
      // budget above max_tokens.
      expect(result.thinking).toBeUndefined();
      expect(result.output_config).toBeUndefined();
      expect(result.max_tokens).toBe(maxTokens);
    }

    // One token of headroom is enough to keep a real thinking block.
    const usable = rewritten({
      model: "claude-opus-4-8",
      max_tokens: 1025,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" }
    }, "claude-sonnet-4-5-20250929");
    expect(usable.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
});

describe("Claude model role classification", () => {
  const config = {
    claude: { model_map: { default: "D", opus: "", sonnet: "S", haiku: "H", reasoning: "", subagent: "" } }
  } as unknown as Parameters<typeof resolveClaudeMappedModel>[1];

  it("falls back to the model family when the reasoning slot is unset", () => {
    expect(resolveClaudeMappedModel("claude-3-7-sonnet-20250219-thinking", config)).toBe("S");
    expect(resolveClaudeMappedModel("claude-haiku-4-5-20251001", config)).toBe("H");
    expect(resolveClaudeMappedModel("claude-opus-4-8", config)).toBe("D");
  });
});

describe("Claude thinking scene detection", () => {
  it("does not treat an explicitly disabled thinking block as a thinking request", () => {
    expect(detectClaudeScene(body({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" }
    }), "claude-sonnet-4-5-20250929", 0).scene).toBe("default");

    expect(detectClaudeScene(body({
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" }
    }), "claude-opus-4-8", 0).scene).toBe("thinking");
  });
});
