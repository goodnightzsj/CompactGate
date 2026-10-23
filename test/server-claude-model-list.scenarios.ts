import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  postJson,
  startApp,
  startClaudeUpstream,
  waitForLogEntry
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
      expect(req.headers["x-model-list-secret"]).toBe("claude-model-secret");
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
          api_key: "models-token",
          extra_headers: { "x-model-list-secret": "claude-model-secret" }
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

      if (req.url === "/anthropic/v1/models") {
        writeJsonResponse(res, { error: "method not allowed" }, 405);
        return;
      }

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

  it("falls back to the base-relative Claude models path", async () => {
    const requestedUrls: string[] = [];
    const claude = await startClaudeUpstream((req, res) => {
      requestedUrls.push(req.url ?? "");
      expect(req.headers["anthropic-api-key"]).toBe("relative-models-token");

      if (req.url !== "/anthropic/models") {
        writeJsonResponse(res, { error: "not found" }, 404);
        return;
      }

      writeJsonResponse(res, { data: [{ id: "relative-claude-model" }] });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: `${claude.url}/anthropic`,
          api_key: "relative-models-token"
        }
      }
    });

    const { body } = await fetchJson<{
      models: string[];
      error: string | null;
    }>(`${app.url}/api/claude/models`, "GET");

    expect(requestedUrls).toEqual([
      "/anthropic/v1/models",
      "/anthropic/models"
    ]);
    expect(body).toMatchObject({
      models: ["relative-claude-model"],
      error: null
    });
  });

  it("does not hide Claude authentication failures behind path fallback", async () => {
    const requestedUrls: string[] = [];
    const claude = await startClaudeUpstream((req, res) => {
      requestedUrls.push(req.url ?? "");
      writeJsonResponse(res, { error: "unauthorized" }, 401);
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: `${claude.url}/anthropic`,
          api_key: "rejected-token"
        }
      }
    });

    const { body } = await fetchJson<{
      models: string[];
      error: string | null;
    }>(`${app.url}/api/claude/models`, "GET");

    expect(requestedUrls).toEqual(["/anthropic/v1/models"]);
    expect(body.models).toEqual([]);
    expect(body.error).toBe("上游模型列表不可用：认证失败，状态码 401");
  });

  it("introduces itself as a Claude Code client and lets extra_headers override that", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const claude = await startClaudeUpstream((req, res) => {
      seen = req.headers;
      writeJsonResponse(res, { data: [{ id: "gated-claude-model" }] });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claude.url,
          api_key: "identity-token",
          extra_headers: { "x-app": "operator-override" }
        }
      }
    });

    const { body } = await fetchJson<{
      models: string[];
      error: string | null;
    }>(`${app.url}/api/claude/models`, "GET");

    expect(body).toMatchObject({ models: ["gated-claude-model"], error: null });
    // `x-app` and `anthropic-beta` do not satisfy the gate on their own; the
    // product token in `user-agent` is what these relays actually read.
    expect(seen["user-agent"]).toBe("claude-cli/2.1.234 (external, cli)");
    expect(seen["x-app"]).toBe("operator-override");
  });

  it.each(["openai_responses", "openai_chat"])(
    "uses Codex identity for a %s upstream and respects disabled rewriting",
    async (upstreamProtocol) => {
      const agents: Array<string | undefined> = [];
      const claude = await startClaudeUpstream((req, res) => {
        agents.push(req.headers["user-agent"]);
        writeJsonResponse(res, { data: [{ id: "model-probe" }] });
      });
      const app = await startApp(undefined, undefined, {
        claude: { primary: { base_url: claude.url, upstream_protocol: upstreamProtocol } }
      });
      const identity = await postJson(app.url, "/api/client-identity", {
        codex: { extracted_user_agent: "codex-cli/8.8.8" }
      });
      expect(identity.status).toBe(200);
      await identity.text();
      expect((await fetch(`${app.url}/api/claude/models`)).status).toBe(200);

      const disabled = await postJson(app.url, "/api/client-identity", { enabled: false });
      expect(disabled.status).toBe(200);
      await disabled.text();
      expect((await fetch(`${app.url}/api/claude/models`)).status).toBe(200);

      expect(agents).toEqual(["codex-cli/8.8.8", undefined]);
    }
  );
});

describe.each([
  ["", "/v1/models"],
  ["/v1", "/v1/models"],
  ["/vendor", "/vendor/v1/models"],
  ["/vendor/v1/", "/vendor/v1/models"]
])("external Claude model discovery with base path %s", (basePath, expectedPath) => {
  it.each(["/models", "/v1/models"])("forwards GET %s without changing the catalogue or logged path", async (clientPath) => {
    const requestedUrls: string[] = [];
    const catalogue = { object: "list", data: [{ id: "synthetic-claude", display_name: "Synthetic" }], has_more: false };
    const claude = await startClaudeUpstream((req, res) => {
      requestedUrls.push(req.url ?? "");
      if (new URL(req.url ?? "/", "http://upstream.test").pathname !== expectedPath) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>Console</title>");
        return;
      }
      expect(req.method).toBe("GET");
      expect(req.headers.authorization).toBe("Bearer synthetic-models-key");
      expect(req.headers["anthropic-api-key"]).toBe("synthetic-models-key");
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
      const body = gzipSync(JSON.stringify(catalogue));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(body);
    });
    const app = await startApp(undefined, undefined, { claude: { primary: {
      base_url: `${claude.url}${basePath}?base_flag=keep&client_version=old`,
      api_key: "synthetic-models-key"
    } } });
    const query = "?client_version=pi&tag=a&tag=b&after_id=cursor";
    const response = await fetch(`${app.url}/anthropic${clientPath}${query}`, {
      headers: { "anthropic-version": "2023-06-01" }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(catalogue);
    expect(requestedUrls).toEqual([`${expectedPath}?base_flag=keep&client_version=pi&tag=a&tag=b&after_id=cursor`]);
    const entry = await waitForLogEntry(app.url, (log) => log.request_id === response.headers.get("x-compactgate-request-id"));
    expect(entry).toMatchObject({ method: "GET", route: "claude", path: `${clientPath}${query}`, status: 200 });
  });
});

describe("external Claude model alias boundaries", () => {
  it.each([
    ["POST", "/models"],
    ["HEAD", "/models"],
    ["GET", "/models/other"],
    ["GET", "/models/"],
    ["GET", "/models-extra"],
    ["POST", "/v1/messages"]
  ])("preserves %s %s", async (method, pathname) => {
    const requests: string[] = [];
    const claude = await startClaudeUpstream((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      writeJsonResponse(res, { data: [] });
    });
    const app = await startApp(undefined, undefined, { claude: { primary: { base_url: claude.url } } });
    const response = await fetch(`${app.url}/anthropic${pathname}?client_version=pi`, { method });
    expect(response.status).toBe(200);
    await response.text();
    expect(requests).toEqual([`${method} ${pathname}?client_version=pi`]);
  });

  it.each([401, 404, 405, 500])("preserves an upstream %s without fallback or retry", async (status) => {
    const requestedUrls: string[] = [];
    const error = { error: { type: "synthetic_error", message: "Model directory unavailable" } };
    const claude = await startClaudeUpstream((req, res) => {
      requestedUrls.push(req.url ?? "");
      writeJsonResponse(res, error, status);
    });
    const app = await startApp(undefined, undefined, { claude: { primary: { base_url: claude.url } } });
    const response = await fetch(`${app.url}/anthropic/models`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(error);
    expect(requestedUrls).toEqual(["/v1/models"]);
  });
});
