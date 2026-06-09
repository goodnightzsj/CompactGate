import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import {
  buildUpstreamUrl,
  compactUpstreamPath,
  previewRoute,
  rewriteCompactBody
} from "../src/server/routing.js";
import type { CompactGateConfig } from "../src/shared/types.js";

describe("routing helpers", () => {
  it.each([
    ["gpt-5.5", "gpt-5.5-openai-compact"],
    ["gpt-5.4", "gpt-5.4-openai-compact"]
  ])("rewrites linked compact model %s", (sourceModel, targetModel) => {
    const result = rewriteCompactBody(
      Buffer.from(JSON.stringify({ model: sourceModel, stream: true, input: "redacted" })),
      DEFAULT_CONFIG
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
    expect(preview.upstream_url).toBe("https://compact.example/v1/responses");
    expect(preview.source_model).toBe("gpt-5.5");
    expect(preview.target_model).toBe("gpt-5.5-openai-compact");
    expect(preview.body_rewritten).toBe(true);
    expect(preview.stream_removed).toBe(false);
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

  it("rewrites the local compact endpoint to the standard upstream responses path", () => {
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

    expect(compactUpstreamPath(config, "/v1/responses/compact")).toBe("/v1/responses");
    expect(preview.route).toBe("compact");
    expect(preview.upstream_url).toBe("https://compact-route.example/v1/responses?trace=1");
    expect(preview.target_model).toBe("gpt-5.5-openai-compact");
  });
});
