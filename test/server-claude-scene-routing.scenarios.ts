import { stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicConfig, RoutePreviewResponse } from "../src/shared/types.js";
import {
  type CapturedRequest,
  startApp
} from "./helpers/server-test-utils.js";
import {
  CLAUDE_HEADERS,
  fetchJson,
  postClaudeMessage,
  startCapturedClaudeUpstream,
  writeJsonResponse
} from "./server-claude-core-helpers.js";

describe("Claude request-scoped routing", () => {
  it("routes scenes and explicit profiles concurrently without mutating active config", async () => {
    const sceneRequests: CapturedRequest[] = [];
    const explicitRequests: CapturedRequest[] = [];
    const sceneUpstream = await startCapturedClaudeUpstream(sceneRequests, (_req, res) => {
      writeJsonResponse(res, { type: "message", content: [{ type: "text", text: "scene" }] });
    });
    const explicitUpstream = await startCapturedClaudeUpstream(explicitRequests, (_req, res) => {
      writeJsonResponse(res, { type: "message", content: [{ type: "text", text: "explicit" }] });
    });
    const app = await startApp();

    const sceneProfile = await saveClaudeProfile(
      app.url,
      "Scene profile",
      sceneUpstream.url,
      "scene-profile-key",
      "scene-profile-default"
    );
    const explicitProfile = await saveClaudeProfile(
      app.url,
      "Explicit profile",
      explicitUpstream.url,
      "explicit-profile-key",
      "explicit-profile-model"
    );
    const patchResponse = await fetch(`${app.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        claude: {
          scene_map: {
            web_search: {
              profile_id: sceneProfile.id,
              model: "scene-search-model"
            }
          }
        }
      })
    });
    expect(patchResponse.status).toBe(200);

    const preview = await fetchJson<RoutePreviewResponse>(
      `${app.url}/api/test-route`,
      "POST",
      {
        path: "/anthropic/v1/messages",
        body: {
          model: "claude-sonnet-4-6",
          tools: [{ type: "web_search_20250305" }],
          messages: [{ role: "user", content: "preview search" }]
        }
      }
    );
    expect(preview.body).toMatchObject({
      route: "claude",
      upstream_host: new URL(sceneUpstream.url).host,
      target_model: "scene-search-model",
      profile_id: sceneProfile.id,
      profile_source: "scene",
      claude_scene: "web_search"
    });

    const configPath = path.join(app.dir, "compactgate.json");
    const beforeMtime = (await stat(configPath)).mtimeMs;
    const [sceneResponse, explicitResponse] = await Promise.all([
      postClaudeMessage(app.url, "/anthropic/v1/messages", {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: "search" }]
      }),
      postClaudeMessage(app.url, "/anthropic/v1/messages", {
        model: "claude-sonnet-4-6",
        max_tokens: 32,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: "explicit" }]
      }, {
        ...CLAUDE_HEADERS,
        "x-compactgate-profile": explicitProfile.id
      })
    ]);

    expect(sceneResponse.status).toBe(200);
    expect(sceneResponse.headers.get("x-compactgate-claude-scene")).toBe("web_search");
    expect(sceneResponse.headers.get("x-compactgate-profile")).toBe(sceneProfile.id);
    expect(sceneResponse.headers.get("x-compactgate-profile-source")).toBe("scene");
    expect(explicitResponse.status).toBe(200);
    expect(explicitResponse.headers.get("x-compactgate-profile")).toBe(explicitProfile.id);
    expect(explicitResponse.headers.get("x-compactgate-profile-source")).toBe("explicit");

    expect(sceneRequests).toHaveLength(1);
    expect(sceneRequests[0]?.headers["anthropic-api-key"]).toBe("scene-profile-key");
    expect(sceneRequests[0]?.headers["x-compactgate-profile"]).toBeUndefined();
    expect(JSON.parse(sceneRequests[0]!.body).model).toBe("scene-search-model");
    expect(explicitRequests).toHaveLength(1);
    expect(explicitRequests[0]?.headers["anthropic-api-key"]).toBe("explicit-profile-key");
    expect(explicitRequests[0]?.headers["x-compactgate-profile"]).toBeUndefined();
    expect(JSON.parse(explicitRequests[0]!.body).model).toBe("explicit-profile-model");

    const config = await fetch(`${app.url}/api/config`).then(
      (response) => response.json() as Promise<PublicConfig>
    );
    expect(config.profile_scopes.claude.active_profile_id).toBeNull();
    expect((await stat(configPath)).mtimeMs).toBe(beforeMtime);
  });
});

async function saveClaudeProfile(
  appUrl: string,
  name: string,
  baseUrl: string,
  apiKey: string,
  model: string
) {
  const { response, body } = await fetchJson<PublicConfig>(
    `${appUrl}/api/config/profiles`,
    "POST",
    {
      scope: "claude",
      name,
      config: {
        claude: {
          primary: {
            base_url: baseUrl,
            api_key: apiKey,
            model_override: model
          }
        }
      }
    }
  );
  expect(response.status).toBe(200);
  const profile = body.profile_scopes.claude.profiles.find((candidate) => candidate.name === name);
  if (!profile) {
    throw new Error(`Expected saved Claude profile: ${name}`);
  }
  return profile;
}
