import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import {
  buildUpstreamUrl,
  compactUpstreamPath,
  previewRoute,
  routeForPath,
  rewriteCompactBody,
  rewritePrimaryBody
} from "../src/server/routing.js";
import type { CompactGateConfig } from "../src/shared/types.js";

describe("routing helpers", () => {
  it.each([
    ["gpt-5.5", "gpt-5.5-openai-compact"],
    ["gpt-5.4", "gpt-5.4-openai-compact"]
  ])("rewrites linked compact model %s", (sourceModel, targetModel) => {
    const config: CompactGateConfig = {
      ...DEFAULT_CONFIG,
      primary: { ...DEFAULT_CONFIG.primary, model_override: sourceModel }
    };
    const result = rewriteCompactBody(
      Buffer.from(JSON.stringify({ model: sourceModel, stream: true, input: "redacted" })),
      config
    );

    expect(result.sourceModel).toBe(sourceModel);
    expect(result.targetModel).toBe(targetModel);
    expect(result.streamRemoved).toBe(false);
    expect(JSON.parse(result.body.toString("utf8"))).toEqual({
      model: targetModel,
      stream: true,
      input: "redacted"
    });
  });

  it("uses the custom compact model override", () => {
    const config: CompactGateConfig = {
      ...DEFAULT_CONFIG,
      compact: {
        ...DEFAULT_CONFIG.compact,
        model_mode: "custom",
        model_override: "manual-compact"
      }
    };

    const result = rewriteCompactBody(Buffer.from(JSON.stringify({ model: "gpt-5.5" })), config);

    expect(result.targetModel).toBe("manual-compact");
  });

  it("rewrites primary request models when a primary override is configured", () => {
    const result = rewritePrimaryBody(
      Buffer.from(JSON.stringify({ model: "gpt-5.4", input: "redacted" })),
      DEFAULT_CONFIG
    );

    expect(result.sourceModel).toBe("gpt-5.4");
    expect(result.targetModel).toBe("gpt-5.5");
    expect(result.bodyRewritten).toBe(true);
    expect(JSON.parse(result.body.toString("utf8"))).toEqual({
      model: "gpt-5.5",
      input: "redacted"
    });
  });

  it("passes through primary request bodies that do not contain a string model", () => {
    const rawBody = Buffer.from(JSON.stringify({ input: "redacted" }));
    const result = rewritePrimaryBody(rawBody, DEFAULT_CONFIG);

    expect(result.sourceModel).toBeNull();
    expect(result.targetModel).toBeNull();
    expect(result.bodyRewritten).toBe(false);
    expect(result.body).toBe(rawBody);
  });

  it("passes through non-JSON primary request bodies", () => {
    const rawBody = Buffer.from("not json");
    const result = rewritePrimaryBody(rawBody, DEFAULT_CONFIG);

    expect(result.sourceModel).toBeNull();
    expect(result.targetModel).toBeNull();
    expect(result.bodyRewritten).toBe(false);
    expect(result.body).toBe(rawBody);
  });

  it("overrides Responses reasoning effort while preserving other reasoning fields", () => {
    const config: CompactGateConfig = {
      ...DEFAULT_CONFIG,
      primary: {
        ...DEFAULT_CONFIG.primary,
        model_override: "",
        reasoning_effort: "xhigh"
      }
    };
    const result = rewritePrimaryBody(
      Buffer.from(JSON.stringify({
        model: "gpt-5.6-sol",
        input: "redacted",
        reasoning: { summary: "auto", context: "all_turns", effort: "low" }
      })),
      config,
      "/responses"
    );

    expect(result.targetModel).toBe("gpt-5.6-sol");
    expect(result.bodyRewritten).toBe(true);
    expect(JSON.parse(result.body.toString("utf8"))).toEqual({
      model: "gpt-5.6-sol",
      input: "redacted",
      reasoning: { summary: "auto", context: "all_turns", effort: "xhigh" }
    });
  });

  it("does not add Responses reasoning settings to other primary endpoints", () => {
    const rawBody = Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", messages: [] }));
    const result = rewritePrimaryBody(
      rawBody,
      {
        ...DEFAULT_CONFIG,
        primary: {
          ...DEFAULT_CONFIG.primary,
          model_override: "",
          reasoning_effort: "high"
        }
      },
      "/chat/completions"
    );

    expect(result.bodyRewritten).toBe(false);
    expect(result.body).toBe(rawBody);
  });

  it("builds upstream URLs under the configured /v1 base", () => {
    expect(
      buildUpstreamUrl("https://compact.example/v1", "/v1/responses/compact", "?trace=1").toString()
    ).toBe("https://compact.example/v1/responses/compact?trace=1");
  });

  it("previews compact routing and body rewrite", () => {
    const preview = previewRoute(
      "POST",
      "/v1/responses/compact",
      { model: "gpt-5.5", stream: true },
      DEFAULT_CONFIG
    );

    expect(preview.route).toBe("compact");
    expect(preview.upstream_url).toBe("https://compact.example/v1/responses/compact");
    expect(preview.source_model).toBe("gpt-5.5");
    expect(preview.target_model).toBe("gpt-5.5-openai-compact");
    expect(preview.body_rewritten).toBe(true);
    expect(preview.stream_removed).toBe(false);
  });

  it("treats /v1/responses compaction_trigger requests as compact route traffic", () => {
    const body = {
      model: "gpt-5.5",
      input: [
        {
          type: "compaction_trigger",
          content: [{ type: "input_text", text: "summarize the conversation" }]
        }
      ]
    };

    expect(routeForPath("/v1/responses", Buffer.from(JSON.stringify(body)))).toBe("compact");

    const preview = previewRoute("POST", "/v1/responses", body, DEFAULT_CONFIG);
    expect(preview.route).toBe("compact");
    expect(preview.upstream_url).toBe("https://compact.example/v1/responses");
    expect(preview.source_model).toBe("gpt-5.5");
    expect(preview.target_model).toBe("gpt-5.5-openai-compact");
    expect(preview.body_rewritten).toBe(true);
  });

  it("previews primary model override rewrites", () => {
    const preview = previewRoute(
      "POST",
      "/v1/responses",
      { model: "gpt-5.4", input: "redacted" },
      DEFAULT_CONFIG
    );

    expect(preview.route).toBe("primary");
    expect(preview.source_model).toBe("gpt-5.4");
    expect(preview.target_model).toBe("gpt-5.5");
    expect(preview.body_rewritten).toBe(true);
  });

  it("previews primary passthrough mode without a target rewrite", () => {
    const preview = previewRoute(
      "POST",
      "/v1/responses",
      { model: "gpt-5.4", input: "redacted" },
      {
        ...DEFAULT_CONFIG,
        primary: {
          ...DEFAULT_CONFIG.primary,
          model_override: ""
        }
      }
    );

    expect(preview.route).toBe("primary");
    expect(preview.source_model).toBe("gpt-5.4");
    expect(preview.target_model).toBe("gpt-5.4");
    expect(preview.body_rewritten).toBe(false);
  });

  it("previews compact routing against primary when upstream mode is primary", () => {
    const preview = previewRoute(
      "POST",
      "/v1/responses/compact",
      { model: "gpt-5.5", stream: true },
      {
        ...DEFAULT_CONFIG,
        compact: {
          ...DEFAULT_CONFIG.compact,
          upstream_mode: "primary"
        }
      }
    );

    expect(preview.route).toBe("compact");
    expect(preview.upstream_host).toBe("primary.example");
    expect(preview.target_model).toBe("gpt-5.5-openai-compact");
  });

  it("preserves the native compact endpoint when forwarding upstream", () => {
    const config: CompactGateConfig = {
      ...DEFAULT_CONFIG,
      primary: {
        ...DEFAULT_CONFIG.primary,
        base_url: "https://primary-route.example/v1"
      },
      compact: {
        ...DEFAULT_CONFIG.compact,
        base_url: "https://compact-route.example/v1"
      }
    };
    const preview = previewRoute(
      "POST",
      "/v1/responses/compact?trace=1",
      { model: "gpt-5.5", stream: true },
      config
    );

    expect(compactUpstreamPath(config, "/v1/responses/compact")).toBe("/v1/responses/compact");
    expect(preview.route).toBe("compact");
    expect(preview.upstream_url).toBe("https://compact-route.example/v1/responses/compact?trace=1");
    expect(preview.target_model).toBe("gpt-5.5-openai-compact");
  });
});
