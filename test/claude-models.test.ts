import { describe, expect, it } from "vitest";
import {
  detectClaudeScene,
  hasClaudeImageInput,
  hostNeedsToolReferenceStripping,
  resolveClaudeMappedModel,
  rewriteClaudeModelBody,
  stripClaudeToolReferenceBlocks
} from "../src/server/claude-models.js";
import { anthropicRequestToResponses, ProtocolConversionError } from "../src/server/protocol-conversion.js";

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
  function rewritten(
    value: unknown,
    model: string,
    endpoint = "https://api.anthropic.com/v1/messages"
  ): Record<string, unknown> {
    return JSON.parse(rewriteClaudeModelBody(body(value), model, new URL(endpoint)).toString());
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
      ["xhigh", 31999],
      ["high", 20000],
      ["medium", 12000],
      ["low", 4800],
      ["minimal", 1600]
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

  it("does not invent an effort for a bare adaptive request needing a budget", () => {
    expect(() => rewritten({
      model: "claude-opus-4-8",
      max_tokens: 32000,
      thinking: { type: "adaptive" }
    }, "claude-sonnet-4-5-20250929")).toThrow(/effort/);
  });

  it("rejects an impossible budget instead of silently disabling thinking", () => {
    for (const maxTokens of [undefined, null, "32000", 0, -1, 512, 1000, 1024, 1024.5]) {
      expect(() => rewritten({
        model: "claude-opus-4-8",
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" }
      }, "claude-sonnet-4-5-20250929")).toThrow(/max_tokens/);
    }

    // One token of headroom is enough to keep a real thinking block.
    const usable = rewritten({
      model: "claude-opus-4-8",
      max_tokens: 1025,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" }
    }, "claude-sonnet-4-5-20250929");
    expect(usable.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(usable.max_tokens).toBe(1025);
  });

  it.each([
    ["https://opencode.9962510.xyz/v1/messages", "global:deepseek-v4.1-flash-sg"],
    ["https://api.deepseek.com/anthropic/v1/messages", "claude-sonnet-4-5"],
    ["https://relay.example/v1/messages", "claude-sonnet-4-5"],
    ["https://api.anthropic.com.evil.test/v1/messages", "claude-sonnet-4-5"],
    ["http://api.anthropic.com/v1/messages", "claude-sonnet-4-5"],
    ["https://api.anthropic.com:8443/v1/messages", "claude-sonnet-4-5"],
    ["https://api.anthropic.com/custom/v1/messages", "claude-sonnet-4-5"],
    ["https://api.anthropic.com/v1/messages/count_tokens", "claude-sonnet-4-5"],
    ["https://api.anthropic.com/v1/messages", "global:claude-sonnet-4-5"],
    ["https://api.anthropic.com/v1/messages", "claude-sonnet-4-5-20990101"],
    ["https://api.anthropic.com/v1/messages", "claude-opus-6"],
    ["https://api.anthropic.com/v1/messages", "constructor"]
  ])("preserves unknown endpoint/model capabilities: %s %s", (endpoint, model) => {
    const request = {
      model: "claude-opus-5-5", max_tokens: 128000,
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "max", future_constraint: true }
    };
    expect(rewritten(request, model, endpoint)).toEqual({ ...request, model });
  });

  it("does not reinterpret an unchanged model, even with an unfamiliar configuration", () => {
    const raw = Buffer.from('{ "model": "claude-sonnet-4-5", "thinking": {"type":"adaptive"}, "max_tokens":512 }');
    expect(rewriteClaudeModelBody(raw, "claude-sonnet-4-5", new URL("https://api.anthropic.com/v1/messages"))).toBe(raw);
  });

  it("preserves an unknown relay's manual budget even for an official-looking target", () => {
    const request = {
      model: "client-model", max_tokens: 512,
      thinking: { type: "enabled", budget_tokens: 256 }, output_config: { effort: "future-tier" }
    };
    expect(rewritten(request, "claude-opus-5", "https://relay.example/v1/messages"))
      .toEqual({ ...request, model: "claude-opus-5" });
  });

  it.each(["claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-haiku-4-5", "claude-haiku-4-5-20251001"])(
    "recognizes the verified manual-only model %s", model => {
      expect(rewritten({
        model: "claude-opus-5", max_tokens: 32000, thinking: { type: "adaptive" }, output_config: { effort: "high" }
      }, model)).toEqual({ model, max_tokens: 32000, thinking: { type: "enabled", budget_tokens: 20000 } });
    }
  );

  it.each(["claude-opus-4-6", "claude-sonnet-4-6", "claude-mythos-preview"])(
    "preserves either accepted thinking mode on %s", model => {
      for (const thinking of [{ type: "adaptive" }, { type: "enabled", budget_tokens: 16000 }]) {
        const request = { model: "client-model", max_tokens: 32000, thinking, output_config: { effort: "high" } };
        expect(rewritten(request, model)).toEqual({ ...request, model });
      }
    }
  );

  it.each([
    "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
    "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5",
    "claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1"
  ])("converts a manual budget only when the official target %s requires adaptive", model => {
    expect(rewritten({
      model: "claude-sonnet-4-5", max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 16000, display: "omitted" }
    }, model)).toEqual({
      model, max_tokens: 32000,
      thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "high" }
    });
  });

  it("preserves output constraints in both conversion directions and explicit effort over heuristics", () => {
    const format = { type: "json_schema", schema: { type: "object" } };
    const output = { format, future_constraint: { on: true } };
    const budget = {
      model: "claude-opus-4-5", max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 31999, display: "omitted" },
      output_config: { ...output, effort: "low" }
    };
    expect(rewritten(budget, "claude-opus-5")).toEqual({
      ...budget, model: "claude-opus-5", thinking: { type: "adaptive", display: "omitted" },
      output_config: { ...output, effort: "low" }
    });
    expect(rewritten({ ...budget, output_config: output }, "claude-opus-5").output_config).toEqual({ ...output, effort: "max" });
    const adaptive = {
      ...budget, model: "claude-opus-5", thinking: { type: "adaptive", display: "omitted" },
      output_config: { ...output, effort: "high" }
    };
    expect(rewritten(adaptive, "claude-sonnet-4-5")).toEqual({
      ...adaptive, model: "claude-sonnet-4-5", thinking: { type: "enabled", budget_tokens: 20000, display: "omitted" },
      output_config: output
    });
    for (const model of ["claude-opus-4-5", "claude-opus-4-5-20251101"]) {
      expect(rewritten(adaptive, model)).toEqual({
        ...adaptive, model, thinking: { type: "enabled", budget_tokens: 20000, display: "omitted" }
      });
    }
  });

  it.each([undefined, { type: "disabled" }, { type: "between_tools" }])(
    "never enables thinking or consumes effort on a non-adaptive request: %j", thinking => {
      const request = { model: "client-model", max_tokens: 512, thinking, output_config: { effort: "max" } };
      expect(rewritten(request, "claude-sonnet-4-5")).toEqual(JSON.parse(JSON.stringify({ ...request, model: "claude-sonnet-4-5" })));
    }
  );

  it("rejects invalid or unsupported explicit effort only when it must translate", () => {
    for (const effort of ["turbo", "", "HIGH", null, 5]) {
      for (const thinking of [{ type: "adaptive" }, { type: "enabled", budget_tokens: 8192 }]) {
        const target = thinking.type === "adaptive" ? "claude-sonnet-4-5" : "claude-opus-5";
        expect(() => rewritten({
          model: "client-model", max_tokens: 32000, thinking, output_config: { effort }
        }, target)).toThrow(ProtocolConversionError);
      }
    }
    expect(() => rewritten({
      model: "claude-opus-5", max_tokens: 32000,
      thinking: { type: "adaptive" }, output_config: { effort: "max" }
    }, "claude-opus-4-5")).toThrow(/effort/);
  });

  it("does not invent a budget or replace malformed output_config when converting to adaptive", () => {
    for (const budget of [undefined, null, 0, 1023, 1024.5, "16000"]) {
      expect(() => rewritten({
        model: "claude-sonnet-4-5", max_tokens: 32000, thinking: { type: "enabled", budget_tokens: budget }
      }, "claude-opus-5")).toThrow(/budget_tokens/);
    }
    for (const output_config of [null, "high", []]) {
      expect(() => rewritten({
        model: "claude-sonnet-4-5", max_tokens: 32000,
        thinking: { type: "enabled", budget_tokens: 8192 }, output_config
      }, "claude-opus-5")).toThrow(/output_config/);
    }
    for (const max_tokens of [undefined, null, "32000", 0, -1, 8192.5]) {
      expect(() => rewritten({
        model: "claude-sonnet-4-5", max_tokens, thinking: { type: "enabled", budget_tokens: 8192 }
      }, "claude-opus-5")).toThrow(/max_tokens/);
    }
    expect(() => rewritten({
      model: "claude-opus-5", max_tokens: 32000,
      thinking: { type: "adaptive", budget_tokens: 8192 }, output_config: { effort: "high" }
    }, "claude-sonnet-4-5")).toThrow(/ambiguous/);
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

describe("Claude tool_reference stripping on a model rewrite", () => {
  // The rewrite and the strip are separate steps now: the caller decides the
  // strip from the resolved upstream host, so this mirrors that two-step shape.
  function rewritten(
    value: unknown,
    model = "deepseek/deepseek-v4.1-flash",
    align = true,
    stripToolReferences = true
  ) {
    const rewrittenBody = rewriteClaudeModelBody(body(value), model, align ? new URL("https://relay.example/v1/messages") : undefined);
    return JSON.parse(
      (stripToolReferences ? stripClaudeToolReferenceBlocks(rewrittenBody) : rewrittenBody).toString()
    );
  }

  const withToolReference = {
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "tool_reference", tool_name: "mcp__playwright__browser_navigate" },
            { type: "tool_reference", tool_name: "mcp__playwright__browser_evaluate" }
          ]
        }]
      }
    ]
  };

  it("replaces tool_reference blocks with the names, keeping the exchange well-formed", () => {
    const result = rewritten(withToolReference);
    expect(result.messages[1].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: [{
        type: "text",
        text: "mcp__playwright__browser_navigate\nmcp__playwright__browser_evaluate"
      }]
    });
  });

  it("keeps sibling tool_result content alongside the replacement", () => {
    const result = rewritten({
      model: "claude-opus-4-8",
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "Tool loaded." },
            { type: "tool_reference", tool_name: "Bash" }
          ]
        }]
      }]
    });
    expect(result.messages[0].content[0].content).toEqual([
      { type: "text", text: "Tool loaded." },
      { type: "text", text: "Bash" }
    ]);
  });

  it("leaves a body without tool_reference byte-identical", () => {
    const plain = {
      model: "claude-opus-4-8",
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }]
    };
    expect(rewritten(plain).messages).toEqual(plain.messages);
  });

  it("strips for the OpenAI-protocol path too, whose converters 422 on the block", () => {
    // The OpenAI branch omits the native endpoint; stripping is a separate
    // step and must still fire, or anthropicRequestToResponses refuses the
    // request locally before any upstream sees it.
    const converted = rewritten(withToolReference, "deepseek/deepseek-v4.1-flash", false, true);
    expect(converted.messages[1].content[0].content).toEqual([{
      type: "text",
      text: "mcp__playwright__browser_navigate\nmcp__playwright__browser_evaluate"
    }]);
    expect(() => anthropicRequestToResponses(
      Buffer.from(JSON.stringify(converted)),
      { countTokens: false }
    )).not.toThrow();
  });

  it("leaves the block untouched on a host that never rejected it", () => {
    // The default is not to strip: only relays confirmed to refuse the block are
    // in the list. A host that passes it through keeps the accurate record of
    // which tools the turn loaded.
    const otherHost = rewritten(withToolReference, "deepseek/deepseek-v4.1-flash", true, false);
    expect(otherHost.messages).toEqual(withToolReference.messages);
    expect(otherHost.messages[1].content[0].content).toEqual([
      { type: "tool_reference", tool_name: "mcp__playwright__browser_navigate" },
      { type: "tool_reference", tool_name: "mcp__playwright__browser_evaluate" }
    ]);
  });
});

describe("tool_reference stripping host scope", () => {
  it("matches the confirmed host and its subdomains, and nothing else", () => {
    expect(hostNeedsToolReferenceStripping("opencode.9962510.xyz")).toBe(true);
    expect(hostNeedsToolReferenceStripping("OpenCode.9962510.XYZ")).toBe(true);
    expect(hostNeedsToolReferenceStripping("  opencode.9962510.xyz  ")).toBe(true);
    expect(hostNeedsToolReferenceStripping("cdn.opencode.9962510.xyz")).toBe(true);

    // A suffix match must not be fooled by a host that merely contains the name.
    expect(hostNeedsToolReferenceStripping("notopencode.9962510.xyz")).toBe(false);
    expect(hostNeedsToolReferenceStripping("opencode.9962510.xyz.evil.test")).toBe(false);
    expect(hostNeedsToolReferenceStripping("anyrouter.top")).toBe(false);
    expect(hostNeedsToolReferenceStripping("agentrouter.org")).toBe(false);
    expect(hostNeedsToolReferenceStripping("")).toBe(false);
  });
});
