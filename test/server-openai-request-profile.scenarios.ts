import { stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicConfig, RoutePreviewResponse } from "../src/shared/types.js";
import {
  captureRequest,
  type CapturedRequest,
  fetchJson,
  startApp,
  startUpstream,
  writeJsonResponse
} from "./helpers/server-test-utils.js";

describe("Codex request-scoped profiles", () => {
  it("selects primary and compact transport without active or stickiness side effects", async () => {
    const aRequests: CapturedRequest[] = [];
    const bPrimaryRequests: CapturedRequest[] = [];
    const bCompactRequests: CapturedRequest[] = [];
    const upstreamA = await startUpstream(async (req, res) => {
      aRequests.push(await captureRequest(req));
      writeJsonResponse(res, {
        id: "resp_a",
        object: "response",
        model: "model-a",
        output: []
      });
    });
    const upstreamBPrimary = await startUpstream(async (req, res) => {
      bPrimaryRequests.push(await captureRequest(req));
      writeJsonResponse(res, {
        id: "resp_b",
        object: "response",
        model: "model-b",
        output: [{ type: "compaction", encrypted_content: "state-b" }]
      });
    });
    const upstreamBCompact = await startUpstream(async (req, res) => {
      bCompactRequests.push(await captureRequest(req));
      writeJsonResponse(res, { output: [] });
    });
    const app = await startApp();

    const profileA = await saveCodexProfile(app.url, "Profile A", {
      primaryUrl: upstreamA.url,
      primaryKey: "key-a",
      primaryModel: "model-a",
      compactUrl: upstreamA.url,
      compactKey: "compact-key-a",
      compactModel: "compact-model-a"
    });
    const profileB = await saveCodexProfile(app.url, "Profile B", {
      primaryUrl: upstreamBPrimary.url,
      primaryKey: "key-b",
      primaryModel: "model-b",
      compactUrl: upstreamBCompact.url,
      compactKey: "compact-key-b",
      compactModel: "compact-model-b"
    });
    const applyA = await fetchJson<PublicConfig>(
      `${app.url}/api/config/profiles/apply`,
      "POST",
      { profile_id: profileA.id }
    );
    expect(applyA.response.status).toBe(200);

    const preview = await fetchJson<RoutePreviewResponse>(
      `${app.url}/api/test-route`,
      "POST",
      {
        path: "/v1/responses",
        headers: { "x-compactgate-profile": profileB.id },
        body: { model: "client-model", input: "preview" }
      }
    );
    expect(preview.body).toMatchObject({
      upstream_host: new URL(upstreamBPrimary.url).host,
      target_model: "model-b",
      profile_id: profileB.id,
      profile_source: "explicit"
    });

    const configPath = path.join(app.dir, "compactgate.json");
    const beforeMtime = (await stat(configPath)).mtimeMs;
    const explicitV2 = await postOpenAi(app.url, "/v1/responses", {
      model: "client-model",
      input: [{ type: "compaction_trigger" }]
    }, {
      "x-compactgate-profile": profileB.id,
      "x-compactgate-session": "request-profile-session"
    });
    expect(explicitV2.status).toBe(200);
    expect(explicitV2.headers.get("x-compactgate-profile")).toBe(profileB.id);
    expect(explicitV2.headers.get("x-compactgate-profile-source")).toBe("explicit");
    expect(explicitV2.headers.get("x-compactgate-compaction-mode")).toBe("remote_v2");

    const activeRequest = await postOpenAi(app.url, "/v1/responses", {
      model: "client-model",
      input: "active profile"
    }, { "x-compactgate-session": "request-profile-session" });
    expect(activeRequest.status).toBe(200);

    const explicitCompact = await postOpenAi(app.url, "/v1/responses/compact", {
      model: "client-model",
      input: "compact profile"
    }, { "x-compactgate-profile": profileB.id });
    expect(explicitCompact.status).toBe(200);
    expect(explicitCompact.headers.get("x-compactgate-profile")).toBe(profileB.id);

    expect(bPrimaryRequests).toHaveLength(1);
    expect(bPrimaryRequests[0]?.headers.authorization).toBe("Bearer key-b");
    expect(bPrimaryRequests[0]?.headers["x-profile-route"]).toBe("Profile B");
    expect(bPrimaryRequests[0]?.headers["x-compactgate-profile"]).toBeUndefined();
    expect(JSON.parse(bPrimaryRequests[0]!.body).model).toBe("model-b");
    expect(aRequests).toHaveLength(1);
    expect(aRequests[0]?.headers.authorization).toBe("Bearer key-a");
    expect(JSON.parse(aRequests[0]!.body).model).toBe("model-a");
    expect(bCompactRequests).toHaveLength(1);
    expect(bCompactRequests[0]?.headers.authorization).toBe("Bearer compact-key-b");
    expect(bCompactRequests[0]?.headers["x-profile-route"]).toBe("Profile B compact");
    expect(bCompactRequests[0]?.headers["x-compactgate-profile"]).toBeUndefined();
    expect(JSON.parse(bCompactRequests[0]!.body).model).toBe("compact-model-b");

    const current = await fetch(`${app.url}/api/config`).then(
      (response) => response.json() as Promise<PublicConfig>
    );
    expect(current.active_profile_id).toBe(profileA.id);
    expect((await stat(configPath)).mtimeMs).toBe(beforeMtime);
  });
});

async function saveCodexProfile(
  appUrl: string,
  name: string,
  input: {
    primaryUrl: string;
    primaryKey: string;
    primaryModel: string;
    compactUrl: string;
    compactKey: string;
    compactModel: string;
  }
) {
  const { response, body } = await fetchJson<PublicConfig>(
    `${appUrl}/api/config/profiles`,
    "POST",
    {
      name,
      config: {
        primary: {
          base_url: input.primaryUrl,
          api_key: input.primaryKey,
          model_override: input.primaryModel,
          extra_headers: { "x-profile-route": name }
        },
        compact: {
          base_url: input.compactUrl,
          api_key: input.compactKey,
          upstream_mode: "split",
          model_mode: "custom",
          model_override: input.compactModel,
          extra_headers: { "x-profile-route": `${name} compact` }
        }
      }
    }
  );
  expect(response.status).toBe(200);
  const profile = body.profiles.find((candidate) => candidate.name === name);
  if (!profile) {
    throw new Error(`Expected saved Codex profile: ${name}`);
  }
  return profile;
}

function postOpenAi(
  appUrl: string,
  route: string,
  body: unknown,
  headers: Record<string, string>
): Promise<Response> {
  return fetch(`${appUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}
