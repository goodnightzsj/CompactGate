import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  startApp,
  startClaudeUpstream
} from "./helpers/server-test-utils.js";
import {
  fetchJson,
  writeJsonResponse
} from "./server-claude-core-helpers.js";

describe("CompactGate Claude routing", () => {
  it("fetches Claude models from the active Claude upstream", async () => {
    const claude = await startClaudeUpstream((req, res) => {
      expect(req.url).toBe("/v1/models");
      expect(req.headers["anthropic-api-key"]).toBe("models-token");
      writeJsonResponse(res, {
        data: [
          { id: "claude-sonnet-4-6" },
          { id: "claude-opus-4-8" },
          { name: "claude-haiku-4-6" }
        ]
      });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claude.url,
          api_key: "models-token"
        }
      }
    });

    const { response, body } = await fetchJson<{
      models: string[];
      upstream_host: string;
      error: string | null;
    }>(`${app.url}/api/claude/models`, "GET");

    expect(response.status).toBe(200);
    expect(body).toEqual({
      models: ["claude-haiku-4-6", "claude-opus-4-8", "claude-sonnet-4-6"],
      upstream_host: new URL(claude.url).host,
      error: null
    });
  });

  it("fetches Claude models from gzip encoded upstream JSON", async () => {
    const claude = await startClaudeUpstream((req, res) => {
      expect(req.url).toBe("/v1/models");
      expect(req.headers["anthropic-api-key"]).toBe("gzip-models-token");
      const body = gzipSync(Buffer.from(JSON.stringify({
        data: [
          { id: "claude-sonnet-gzip" },
          { name: "claude-opus-gzip" }
        ]
      })));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(body.byteLength)
      });
      res.end(body);
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claude.url,
          api_key: "gzip-models-token"
        }
      }
    });

    const { response, body } = await fetchJson<{
      models: string[];
      upstream_host: string;
      error: string | null;
    }>(`${app.url}/api/claude/models`, "GET");

    expect(response.status).toBe(200);
    expect(body).toEqual({
      models: ["claude-opus-gzip", "claude-sonnet-gzip"],
      upstream_host: new URL(claude.url).host,
      error: null
    });
  });

  it("falls back across common Claude model list paths", async () => {
    const requestedUrls: string[] = [];
    const claude = await startClaudeUpstream((req, res) => {
      requestedUrls.push(req.url ?? "");
      expect(req.headers["anthropic-api-key"]).toBe("fallback-models-token");

      if (req.url !== "/v1/models") {
        writeJsonResponse(res, { error: "not found" }, 404);
        return;
      }

      writeJsonResponse(res, ["root-claude-opus", { model: "root-claude-sonnet" }]);
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: `${claude.url}/anthropic`,
          api_key: "fallback-models-token"
        }
      }
    });

    const { response, body } = await fetchJson<{
      models: string[];
      upstream_host: string;
      error: string | null;
    }>(`${app.url}/api/claude/models`, "GET");

    expect(response.status).toBe(200);
    expect(requestedUrls).toEqual([
      "/anthropic/v1/models",
      "/anthropic/models",
      "/v1/models"
    ]);
    expect(body).toEqual({
      models: ["root-claude-opus", "root-claude-sonnet"],
      upstream_host: new URL(claude.url).host,
      error: null
    });
  });
});
