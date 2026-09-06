import { describe, expect, it } from "vitest";
import { factoryClientUserAgent } from "../src/server/config-defaults.js";
import {
  postJson,
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

  it("introduces itself as a Codex client and lets extra_headers override that", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const primary = await startUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gated-model" }] }));
    });
    const app = await startApp(primary.url, undefined, {
      primary: {
        api_key: "identity-token",
        extra_headers: { originator: "operator-override" }
      }
    });

    const payload = await (await fetch(`${app.url}/api/openai/models`)).json() as {
      models: string[];
      error: string | null;
    };

    expect(payload).toMatchObject({ models: ["gated-model"], error: null });
    // Without a product token a client-whitelisting relay answers 401, so the
    // probe must carry one where proxied traffic would have forwarded the CLI's.
    // The value now comes from the client-identity store, which on a fresh state
    // file serves the factory Codex UA.
    expect(seen["user-agent"]).toBe(factoryClientUserAgent("codex"));
    expect(seen.originator).toBe("operator-override");
  });

  it("uses the configured wire-protocol identity and respects disabled rewriting", async () => {
    const agents: Array<string | undefined> = [];
    const primary = await startUpstream((req, res) => {
      agents.push(req.headers["user-agent"]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "model-probe" }] }));
    });
    const app = await startApp(primary.url, undefined, {
      primary: { upstream_protocol: "anthropic_messages" }
    });
    const identity = await postJson(app.url, "/api/client-identity", {
      claude: { extracted_user_agent: "claude-cli/8.8.8 (external, cli)" }
    });
    expect(identity.status).toBe(200);
    await identity.text();
    expect((await fetch(`${app.url}/api/openai/models`)).status).toBe(200);

    const disabled = await postJson(app.url, "/api/client-identity", { enabled: false });
    expect(disabled.status).toBe(200);
    await disabled.text();
    expect((await fetch(`${app.url}/api/openai/models`)).status).toBe(200);

    expect(agents).toEqual(["claude-cli/8.8.8 (external, cli)", undefined]);
  });

  it("keeps a configured user-agent even with identity rewriting disabled", async () => {
    let agent: string | undefined;
    const primary = await startUpstream((req, res) => {
      agent = req.headers["user-agent"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const app = await startApp(primary.url, undefined, {
      primary: { extra_headers: { "User-Agent": "operator-agent/1.0.0" } }
    });
    const disabled = await postJson(app.url, "/api/client-identity", { enabled: false });
    expect(disabled.status).toBe(200);
    await disabled.text();
    expect((await fetch(`${app.url}/api/openai/models`)).status).toBe(200);
    expect(agent).toBe("operator-agent/1.0.0");
  });
});
