import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { PublicConfig } from "../src/shared/types.js";
import { startApp } from "./helpers/server-test-utils.js";

describe("CompactGate config API", () => {
  it("hot patches config used by subsequent route previews", async () => {
    const app = await startApp();

    const patchResponse = await fetch(`${app.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        compact: {
          base_url: "http://127.0.0.1:55555/v1",
          model_mode: "custom",
          model_override: "manual-compact"
        }
      })
    });
    expect(patchResponse.status).toBe(200);
    const patchedConfig = (await patchResponse.json()) as PublicConfig;
    expect(patchedConfig.route_url_presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "codex_compact", base_url: "http://127.0.0.1:55555/v1" })
      ])
    );

    const previewResponse = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/v1/responses/compact",
        body: { model: "gpt-5.5" }
      })
    });
    const preview = await previewResponse.json();

    expect(preview.target_model).toBe("manual-compact");
    expect(preview.upstream_host).toBe("127.0.0.1:55555");
  });

  it("rejects malformed route preview paths as client errors", async () => {
    const app = await startApp();

    const response = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "http://%",
        body: { model: "gpt-5.5" }
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "test-route path must be a valid URL or path."
    });
  });

  it("accepts gzip encoded API JSON request bodies", async () => {
    const app = await startApp();
    const requestBody = gzipSync(Buffer.from(JSON.stringify({
      path: "/v1/responses/compact",
      body: { model: "gpt-5.5" }
    })));

    const response = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip"
      },
      body: requestBody
    });
    const preview = await response.json();

    expect(response.status).toBe(200);
    expect(preview).toMatchObject({
      route: "compact",
      source_model: "gpt-5.5",
      target_model: "gpt-5.5-openai-compact"
    });
  });

  it("imports config through the public API without exposing secrets or recording URL preset usage", async () => {
    const app = await startApp();

    const importResponse = await fetch(`${app.url}/api/config/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        listen: "127.0.0.1:7865",
        primary: {
          base_url: "http://127.0.0.1:56201/v1",
          api_key: "import-api-primary-secret",
          api_key_env: ""
        },
        compact: {
          base_url: "http://127.0.0.1:56202/v1",
          api_key: "",
          api_key_env: "",
          upstream_mode: "split",
          model_mode: "custom",
          model_template: "{model}-import",
          model_override: "import-api-compact-model"
        },
        claude: {
          primary: {
            base_url: "http://127.0.0.1:56203",
            api_key: "import-api-claude-secret",
            api_key_env: "ANTHROPIC_AUTH_TOKEN",
            model_override: "import-api-claude-default"
          },
          compact: {
            base_url: "http://127.0.0.1:56204",
            api_key: "",
            api_key_env: "ANTHROPIC_AUTH_TOKEN",
            upstream_mode: "split",
            model_override: "import-api-claude-compact"
          },
          model_map: {
            default: "import-api-claude-default",
            opus: "",
            sonnet: "",
            haiku: "",
            reasoning: "",
            subagent: ""
          }
        },
        timeouts: {
          primary_ms: 1100,
          compact_ms: 2200,
          claude_ms: 3300
        },
        logging: {
          redact_body: true,
          keep_recent: 33
        },
        profile_scopes: {
          codex: {
            active_profile_id: null,
            profiles: []
          },
          claude: {
            active_profile_id: null,
            profiles: []
          }
        },
        route_url_presets: [
          {
            id: "import-api-codex-primary",
            kind: "codex_primary",
            base_url: "http://127.0.0.1:56201/v1",
            host: "127.0.0.1:56201",
            created_at: "2026-06-06T00:00:00.000Z",
            updated_at: "2026-06-06T00:00:00.000Z",
            usage_count: 5
          }
        ]
      })
    });
    const importedConfig = (await importResponse.json()) as PublicConfig;

    expect(importResponse.status).toBe(200);
    expect(importedConfig.primary.base_url).toBe("http://127.0.0.1:56201/v1");
    expect(importedConfig.primary.stored_api_key).toBe(true);
    expect(importedConfig.compact.model_override).toBe("import-api-compact-model");
    expect(importedConfig.claude.primary.base_url).toBe("http://127.0.0.1:56203");
    expect(importedConfig.logging.keep_recent).toBe(33);
    expect(importedConfig.route_url_presets).toEqual([
      expect.objectContaining({
        kind: "codex_primary",
        base_url: "http://127.0.0.1:56201/v1",
        usage_count: 5
      })
    ]);
    expect(JSON.stringify(importedConfig)).not.toContain("import-api-primary-secret");
    expect(JSON.stringify(importedConfig)).not.toContain("import-api-claude-secret");

    const exportResponse = await fetch(`${app.url}/api/config/export`);
    const exportedConfig = await exportResponse.json();

    expect(exportResponse.status).toBe(200);
    expect(exportedConfig.primary.api_key).toBe("import-api-primary-secret");
    expect(exportedConfig.claude.primary.api_key).toBe("import-api-claude-secret");
    expect(exportedConfig.route_url_presets).toEqual([
      expect.objectContaining({
        kind: "codex_primary",
        base_url: "http://127.0.0.1:56201/v1",
        usage_count: 5
      })
    ]);
  });
});
