import { describe, expect, it } from "vitest";
import {
  setEnv,
  startApp,
  startConnectProxy,
  startHttpsClaudeUpstream,
  startUpstream
} from "./helpers/server-test-utils.js";

describe("CompactGate OpenAI model list", () => {
  it("fetches models from the active Primary upstream", async () => {
    const primary = await startUpstream((req, res) => {
      expect(req.url).toBe("/v1/models");
      expect(req.headers.authorization).toBe("Bearer primary-models-token");
      expect(req.headers["x-model-list-secret"]).toBe("primary-model-secret");
      const body = JSON.stringify({
        data: [
          { id: "gpt-compatible-z" },
          { id: "gpt-compatible-a" },
          { id: "gpt-compatible-a" }
        ]
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body))
      });
      res.end(body);
    });
    const app = await startApp(primary.url, undefined, {
      primary: {
        api_key: "primary-models-token",
        extra_headers: { "x-model-list-secret": "primary-model-secret" }
      }
    });

    const response = await fetch(`${app.url}/api/openai/models`);
    const payload = await response.json() as {
      models: string[];
      upstream_host: string;
      error: string | null;
    };

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      models: ["gpt-compatible-a", "gpt-compatible-z"],
      upstream_host: new URL(primary.url).host,
      error: null
    });
  });

  it("uses the active Primary explicit proxy for model discovery", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    setEnv("HTTPS_PROXY", "not-a-valid-proxy-url");
    setEnv("NO_PROXY", "*");
    const upstream = await startHttpsClaudeUpstream((req, res) => {
      expect(req.url).toBe("/v1/models");
      const body = JSON.stringify({ data: [{ id: "proxied-model" }] });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body))
      });
      res.end(body);
    });
    const proxy = await startConnectProxy();
    const app = await startApp(undefined, undefined, {
      primary: {
        base_url: `${upstream.url}/v1`,
        proxy_url: proxy.url
      }
    });

    const response = await fetch(`${app.url}/api/openai/models`);
    const payload = await response.json() as { models: string[] };

    expect(response.status).toBe(200);
    expect(payload.models).toEqual(["proxied-model"]);
    expect(proxy.connectTargets).toContain(new URL(upstream.url).host);
  });

  it("returns a displayable error when the Primary model endpoint rejects authentication", async () => {
    const primary = await startUpstream((_req, res) => {
      const body = JSON.stringify({ error: "unauthorized" });
      res.writeHead(401, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body))
      });
      res.end(body);
    });
    const app = await startApp(primary.url);

    const response = await fetch(`${app.url}/api/openai/models`);
    const payload = await response.json() as {
      models: string[];
      upstream_host: string;
      error: string | null;
    };

    expect(response.status).toBe(200);
    expect(payload.models).toEqual([]);
    expect(payload.error).toBe("上游模型列表不可用：认证失败，状态码 401");
  });

  it("falls back to the root models path after a missing Primary endpoint", async () => {
    const requestedUrls: string[] = [];
    const primary = await startUpstream((req, res) => {
      requestedUrls.push(req.url ?? "");
      expect(req.headers.authorization).toBe("Bearer primary-fallback-token");

      if (req.url !== "/models") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-root-model" }] }));
    });
    const app = await startApp(primary.url, undefined, {
      primary: { api_key: "primary-fallback-token" }
    });

    const response = await fetch(`${app.url}/api/openai/models`);
    const payload = await response.json() as {
      models: string[];
      error: string | null;
    };

    expect(requestedUrls).toEqual(["/v1/models", "/models"]);
    expect(payload).toMatchObject({
      models: ["gpt-root-model"],
      error: null
    });
  });
});
