import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  MIMO_IMAGE_INPUT_MODEL,
  resolveClaudeMappedModel
} from "../src/server/claude-models.js";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import type {
  CompactGateConfig,
  PublicConfig
} from "../src/shared/types.js";
import {
  assertCaptured,
  type CapturedRequest,
  fetchRecentLogs,
  startApp
} from "./helpers/server-test-utils.js";
import {
  fetchJson,
  postClaudeMessage,
  startCapturedClaudeUpstream,
  writeJsonResponse
} from "./server-claude-core-helpers.js";

describe("CompactGate Claude routing", () => {
  it("rewrites ordinary Claude request models from the active Claude profile", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startCapturedClaudeUpstream(captured, (_req, res) => {
      writeJsonResponse(res, { type: "message", content: [{ type: "text", text: "OK" }] });
    });
    const app = await startApp();

    const { response: saveResponse, body: savedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles`,
      "POST",
      {
        scope: "claude",
        name: "Claude model profile",
        config: {
          claude: {
            primary: {
              base_url: claude.url,
              api_key: "profile-claude-token",
              model_override: "deepseek-v4-pro[1m]"
            },
            compact: {
              base_url: claude.url,
              upstream_mode: "primary",
              model_override: "claude-compact-profile-model"
            }
          }
        }
      }
    );
    const profile = savedConfig.profile_scopes.claude.profiles[0];

    expect(saveResponse.status).toBe(200);
    expect(profile).toMatchObject({
      scope: "claude",
      claude_primary_host: new URL(claude.url).host,
      claude_primary_model_override: "deepseek-v4-pro[1m]",
      claude_compact_model_override: "claude-compact-profile-model"
    });

    const { response: applyResponse, body: appliedConfig } = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/apply`,
      "POST",
      { scope: "claude", profile_id: profile.id }
    );

    expect(applyResponse.status).toBe(200);
    expect(appliedConfig.claude.primary.model_override).toBe("deepseek-v4-pro[1m]");

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "profile model rewrite" }]
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    await response.text();
    assertCaptured(captured.current);
    expect(captured.current.headers["anthropic-api-key"]).toBe("profile-claude-token");
    expect(JSON.parse(captured.current.body)).toMatchObject({
      model: "deepseek-v4-pro[1m]",
      messages: [{ role: "user", content: "profile model rewrite" }]
    });

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "claude",
      source_model: "claude-opus-4-8",
      target_model: "deepseek-v4-pro[1m]",
      upstream_host: new URL(claude.url).host
    });
  });

  it("rewrites ordinary Claude request models by Claude role mappings", async () => {
    const captures: CapturedRequest[] = [];
    const claude = await startCapturedClaudeUpstream(captures, (_req, res) => {
      writeJsonResponse(res, { type: "message", content: [{ type: "text", text: "OK" }] });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claude.url,
          api_key: "mapped-claude-token"
        },
        model_map: {
          default: "mapped-default-model",
          opus: "mapped-opus-model",
          sonnet: "mapped-sonnet-model",
          haiku: "mapped-haiku-model",
          reasoning: "mapped-reasoning-model",
          subagent: "mapped-subagent-model"
        }
      }
    });

    const cases = [
      ["claude-opus-4-8", "mapped-opus-model"],
      ["claude-sonnet-4-6", "mapped-sonnet-model"],
      ["claude-haiku-4-6", "mapped-haiku-model"],
      ["reasoning", "mapped-reasoning-model"],
      ["subagent", "mapped-subagent-model"],
      ["provider-specific-model", "mapped-default-model"]
    ] as const;

    for (const [sourceModel, targetModel] of cases) {
      const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
        model: sourceModel,
        messages: [{ role: "user", content: `rewrite ${sourceModel}` }]
      });

      expect(response.status).toBe(200);
      await response.text();
      const captured = captures.at(-1);
      expect(captured).toBeTruthy();
      expect(captured?.headers["anthropic-api-key"]).toBe("mapped-claude-token");
      expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
        model: targetModel,
        messages: [{ role: "user", content: `rewrite ${sourceModel}` }]
      });
    }

    expect(captures).toHaveLength(cases.length);
    const logs = await fetchRecentLogs(app.url);
    expect(logs[0]).toMatchObject({
      route: "claude",
      source_model: "provider-specific-model",
      target_model: "mapped-default-model"
    });
  });

  it("uses the image-capable Mimo model for image input sent to the Mimo upstream host", () => {
    const imageBody = Buffer.from(JSON.stringify({
      model: "claude-opus-4-8",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "check this image" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgo="
              }
            }
          ]
        }
      ]
    }));
    const textBody = Buffer.from(JSON.stringify({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "plain text keeps mapped model" }]
    }));
    const mimoHostConfig = buildMappedClaudeConfig("https://token-plan-sgp.xiaomimimo.com/anthropic");
    const otherHostConfig = buildMappedClaudeConfig("https://other.example/anthropic");

    expect(resolveClaudeMappedModel("claude-opus-4-8", mimoHostConfig, imageBody)).toBe(MIMO_IMAGE_INPUT_MODEL);
    expect(resolveClaudeMappedModel("claude-opus-4-8", mimoHostConfig, textBody)).toBe("mimo-v2.5-pro");
    expect(resolveClaudeMappedModel("claude-opus-4-8", otherHostConfig, imageBody)).toBe("mimo-v2.5-pro");
  });

  it("drops stale gzip encoding headers when rewritten Claude bodies become plain JSON", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startCapturedClaudeUpstream(captured, (_req, res) => {
      writeJsonResponse(res, { type: "message", content: [{ type: "text", text: "OK" }] });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claude.url,
          api_key: "gzip-claude-token"
        },
        model_map: {
          default: "mapped-default-model",
          opus: "",
          sonnet: "",
          haiku: "",
          reasoning: "",
          subagent: ""
        }
      }
    });
    const requestBody = gzipSync(Buffer.from(JSON.stringify({
      model: "provider-specific-model",
      messages: [{ role: "user", content: "gzip rewrite" }]
    })));

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "anthropic-version": "2023-06-01"
      },
      body: requestBody
    });

    expect(response.status).toBe(200);
    await response.text();
    assertCaptured(captured.current);
    expect(captured.current.headers["content-encoding"]).toBeUndefined();
    expect(captured.current.headers["content-length"]).toBe(String(Buffer.byteLength(captured.current.body)));
    expect(JSON.parse(captured.current.body)).toMatchObject({
      model: "mapped-default-model",
      messages: [{ role: "user", content: "gzip rewrite" }]
    });
  });
});

function buildMappedClaudeConfig(baseUrl: string): CompactGateConfig {
  return {
    ...DEFAULT_CONFIG,
    claude: {
      primary: {
        ...DEFAULT_CONFIG.claude.primary,
        base_url: baseUrl,
        model_override: "mimo-v2.5-pro"
      },
      compact: {
        ...DEFAULT_CONFIG.claude.compact,
        base_url: baseUrl
      },
      model_map: {
        default: "mimo-v2.5-pro",
        opus: "mimo-v2.5-pro",
        sonnet: "mimo-v2.5-pro",
        haiku: "mimo-v2.5-pro",
        reasoning: "mimo-v2.5-pro",
        subagent: "mimo-v2.5-pro"
      }
    }
  };
}
