import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCaptured,
  captureBody,
  type CapturedRequest,
  cleanup,
  setEnv,
  startApp,
  startClaudeUpstream,
  startConnectProxy,
  startHttpsClaudeUpstream,
  waitForCaptureRecords,
  waitForLogEntry
} from "./helpers/server-test-utils.js";

describe("CompactGate Claude routing", () => {
  it("uses an HTTP CONNECT proxy for HTTPS Claude upstream requests", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    setEnv("HTTPS_PROXY", "");
    setEnv("https_proxy", "");
    setEnv("HTTP_PROXY", "");
    setEnv("http_proxy", "");
    setEnv("NO_PROXY", "");
    setEnv("no_proxy", "");

    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startHttpsClaudeUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          usage: { input_tokens: 3, output_tokens: 5 },
          content: [{ type: "text", text: "CONNECT_PROXY_OK" }]
        })
      );
    });
    const proxy = await startConnectProxy();
    setEnv("HTTPS_PROXY", proxy.url);

    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "use connect proxy" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("CONNECT_PROXY_OK");
    expect(proxy.connectTargets).toContain(new URL(claude.url).host);
    assertCaptured(captured.current);
    expect(captured.current.headers["anthropic-api-key"]).toBe("saved-claude-token");
    expect(captured.current.body).toContain("use connect proxy");
  });

  it("rejects oversized HTTP CONNECT proxy response headers before TLS setup", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    setEnv("HTTPS_PROXY", "");
    setEnv("https_proxy", "");
    setEnv("HTTP_PROXY", "");
    setEnv("http_proxy", "");
    setEnv("NO_PROXY", "");
    setEnv("no_proxy", "");

    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startHttpsClaudeUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "SHOULD_NOT_REACH" }] }));
    });
    const proxy = await startConnectProxy({ extraConnectHeaderBytes: 70 * 1024 });
    setEnv("HTTPS_PROXY", proxy.url);

    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "oversized connect header" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      }
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Proxy CONNECT response header is too large.");
    expect(proxy.connectTargets).toContain(new URL(claude.url).host);
    expect(captured.current).toBeNull();
  });

  it("handles malformed HTTP CONNECT proxy credentials as a bounded upstream error", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    setEnv("HTTPS_PROXY", "");
    setEnv("https_proxy", "");
    setEnv("HTTP_PROXY", "");
    setEnv("http_proxy", "");
    setEnv("NO_PROXY", "");
    setEnv("no_proxy", "");

    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startHttpsClaudeUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "SHOULD_NOT_REACH" }] }));
    });
    const proxy = await startConnectProxy();
    const proxyUrl = new URL(proxy.url);
    proxyUrl.username = "%E0%A4%A";
    proxyUrl.password = "secret";
    setEnv("HTTPS_PROXY", proxyUrl.toString());

    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "malformed proxy credentials" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      signal: AbortSignal.timeout(1_000)
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Proxy credentials contain malformed percent-encoding.");
    expect(proxy.connectTargets).toHaveLength(0);
    expect(captured.current).toBeNull();
  });

  it("handles HTTP CONNECT proxy closes before a response as a bounded upstream error", async () => {
    setEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    setEnv("HTTPS_PROXY", "");
    setEnv("https_proxy", "");
    setEnv("HTTP_PROXY", "");
    setEnv("http_proxy", "");
    setEnv("NO_PROXY", "");
    setEnv("no_proxy", "");

    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startHttpsClaudeUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "SHOULD_NOT_REACH" }] }));
    });
    const proxy = await startConnectProxy({ closeBeforeConnectResponse: true });
    setEnv("HTTPS_PROXY", proxy.url);

    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "proxy closes before connect response" }]
      }),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      signal: AbortSignal.timeout(1_000)
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Proxy CONNECT connection closed before response.");
    expect(proxy.connectTargets).toContain(new URL(claude.url).host);
    expect(captured.current).toBeNull();
  });

  it("logs and captures Claude requests when the client disconnects before upstream completes", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);

    let markUpstreamReceived: () => void = () => {};
    const upstreamReceived = new Promise<void>((resolve) => {
      markUpstreamReceived = resolve;
    });
    const claude = await startClaudeUpstream(async (req, res) => {
      await captureBody(req);
      markUpstreamReceived();
      res.writeHead(200, { "content-type": "text/event-stream" });
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const request = http.request(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    const requestClosed = new Promise<void>((resolve) => {
      request.once("close", resolve);
    });
    request.on("error", () => undefined);

    request.end(
      JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "disconnect claude" }]
      })
    );
    await upstreamReceived;
    request.destroy();
    await requestClosed;

    const entry = await waitForLogEntry(app.url, (candidate) => candidate.route === "claude");
    expect(entry).toMatchObject({
      route: "claude",
      status: 502,
      endpoint: "/messages",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8",
      error_summary: "Client disconnected before upstream response completed."
    });

    const captures = await waitForCaptureRecords(captureDir, 1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      route: "claude",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8"
    });
    expect(captures[0].upstream_response.status).toBe(502);
    expect(JSON.stringify(captures[0])).not.toContain("saved-claude-token");
  });
});
