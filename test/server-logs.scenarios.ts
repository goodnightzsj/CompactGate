import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DebugCaptureWriter } from "../src/server/debug-capture.js";
import { persistCapture } from "../src/server/proxy-support.js";
import {
  captureBody,
  cleanup,
  cleanupEnvKeys,
  fetchLogPage,
  fetchRecentLogs,
  readLatestLogBodyFields,
  readLogCount,
  seedLegacyLogDatabase,
  sendCompactRequest,
  setEnv,
  startApp,
  startAppInDir,
  startClaudeUpstream,
  startUpstream,
  waitForCaptureRecords
} from "./helpers/server-test-utils.js";

const JSON_HEADERS = { "content-type": "application/json" };

function writeJsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function startJsonUpstream(body: unknown, status = 200) {
  return startUpstream(async (req, res) => {
    await captureBody(req);
    writeJsonResponse(res, body, status);
  });
}

function startClaudeJsonUpstream(body: unknown, status = 200) {
  return startClaudeUpstream(async (req, res) => {
    await captureBody(req);
    writeJsonResponse(res, body, status);
  });
}

function postJson(
  appUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...JSON_HEADERS, ...headers }
  });
}

describe("CompactGate logs and capture", () => {
  it("does not build debug capture records when capture is disabled", async () => {
    let built = false;
    await persistCapture(DebugCaptureWriter.fromEnv(), () => {
      built = true;
      throw new Error("Capture record should not be built when capture is disabled.");
    });

    expect(built).toBe(false);
  });

  it("does not persist raw request and response bodies by default", async () => {
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream({ ok: true });
    const app = await startApp(primary.url, compact.url);

    await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.4",
      input: "sensitive prompt"
    });

    expect(readLatestLogBodyFields(path.join(app.dir, "compactgate-logs.sqlite"))).toEqual({
      incoming_request_body: null,
      upstream_request_body: null,
      upstream_response_body: null,
      client_response_body: null
    });
  });

  it("persists compact request body content without returning it in recent log payloads", async () => {
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream({ ok: true });
    const app = await startApp(primary.url, compact.url, {
      logging: { persist_body: true },
      primary: { model_override: "gpt-5.4" }
    });

    await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.4",
      input: "sensitive prompt"
    }, {
      "user-agent": "CompactGateTest/1.0"
    });

    const [entry] = await fetchRecentLogs(app.url);

    expect(entry).toMatchObject({
      route: "compact",
      status: 200,
      source_model: "gpt-5.4",
      target_model: "gpt-5.4-openai-compact",
      user_agent: "CompactGateTest/1.0",
      incoming_request_body: null,
      upstream_request_body: null,
      upstream_response_body: null,
      client_response_body: null,
      compact_response_normalized: true,
      compact_response_normalize_reason: "missing_compaction_output",
      compact_response_synthetic_source: "request_input"
    });

    const persistedBodies = readLatestLogBodyFields(path.join(app.dir, "compactgate-logs.sqlite"));
    expect(persistedBodies.incoming_request_body).toContain("sensitive prompt");
    expect(persistedBodies.upstream_request_body).toContain("sensitive prompt");
    expect(persistedBodies.upstream_request_body).toContain("gpt-5.4-openai-compact");
    expect(persistedBodies.upstream_response_body).toBe(JSON.stringify({ ok: true }));
    // 方案 B:客户端透明收原始上游流,client_response_body 为空。
    expect(persistedBodies.client_response_body).toBeNull();
  });

  it("audits normalized compact responses with upstream and client bodies", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);
    const summaryText = [
      "- Audit summary from a non-standard compact response.",
      "- CompactGate should return this as local compaction state.",
      "- Logs should preserve both upstream and client response bodies."
    ].join("\n");
    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream({
      id: "resp_audit_normalized",
      object: "response",
      output_text: summaryText
    });
    const app = await startApp(primary.url, compact.url, {
      logging: { persist_body: true }
    });

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "audit normalized compact response"
    });

    // 方案 B:客户端收原始上游 JSON(非归一化)。
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: "response", output_text: summaryText });

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      compact_response_normalized: true,
      compact_response_normalize_reason: "missing_compaction_output",
      compact_response_synthetic_source: "upstream_response",
      response_model: null,
      response_model_source: "target_fallback",
      stream_oversized_event_count: 0,
      upstream_response_body: null,
      client_response_body: null
    });

    const persistedBodies = readLatestLogBodyFields(path.join(app.dir, "compactgate-logs.sqlite"));
    // 方案 B:客户端透明收原始上游流,upstream_response_body 为原始上游,client_response_body 为空。
    expect(persistedBodies.upstream_response_body).toContain('"object":"response"');
    expect(persistedBodies.client_response_body).toBeNull();

    const [capture] = await waitForCaptureRecords(captureDir, 1);
    expect(capture).toMatchObject({
      route: "compact",
      compact_response_normalized: true,
      compact_response_normalize_reason: "missing_compaction_output",
      compact_response_synthetic_source: "upstream_response",
      response_model: null,
      response_model_source: "target_fallback",
      stream_oversized_event_count: 0
    });
    expect(capture.upstream_response.body.text).toContain('"object":"response"');
    // 方案 B:无独立客户端响应体(透明转发),capture 的 client_response 为空。
    expect(capture.client_response).toBeNull();
  });

  it("returns faceted route, status, and host counts with upstream error summaries", async () => {
    const primary = await startJsonUpstream({ ok: true });
    const compact = await startJsonUpstream({
      error: {
        message: "bad compact model",
        type: "invalid_request_error"
      }
    }, 400);
    const claude = await startClaudeJsonUpstream({
      type: "message",
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    const app = await startApp(primary.url, compact.url, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const primaryResponse = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "do not expose"
    });
    expect(primaryResponse.status).toBe(200);
    await primaryResponse.text();

    const compactResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5",
      input: "do not expose"
    });
    expect(compactResponse.status).toBe(400);
    await compactResponse.text();

    const claudeResponse = await postJson(
      app.url,
      "/anthropic/v1/messages",
      {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "do not expose" }]
      },
      {
        "anthropic-version": "2023-06-01"
      }
    );
    expect(claudeResponse.status).toBe(200);
    await claudeResponse.text();

    const allPage = await fetchLogPage(app.url);
    expect(allPage.total).toBe(3);
    expect(allPage.counts).toEqual({
      all: 3,
      primary: 1,
      compact: 1,
      claude: 1
    });
    expect(allPage.status_counts).toEqual({
      all: 3,
      normal: 2,
      error: 1
    });

    const errorPage = await fetchLogPage(app.url, "?status=error");
    expect(errorPage.logs).toHaveLength(1);
    expect(errorPage.logs[0]).toMatchObject({
      route: "compact",
      status: 400,
      upstream_status: 400,
      stream_outcome: "upstream_http_error",
      error_summary: "Upstream returned HTTP 400: bad compact model (invalid_request_error)",
      request_summary: "input text"
    });
    expect(errorPage.counts).toEqual({
      all: 1,
      primary: 0,
      compact: 1,
      claude: 0
    });
    expect(errorPage.status_counts).toEqual({
      all: 3,
      normal: 2,
      error: 1
    });
    expect(errorPage.host_counts).toEqual([
      {
        host: new URL(compact.url).host,
        total: 1,
        primary: 0,
        compact: 1,
        claude: 0
      }
    ]);

    const primaryHostParams = new URLSearchParams({ host: new URL(primary.url).host });
    const primaryHostPage = await fetchLogPage(app.url, `?${primaryHostParams.toString()}`);
    expect(primaryHostPage.logs).toHaveLength(1);
    expect(primaryHostPage.counts).toEqual({
      all: 1,
      primary: 1,
      compact: 0,
      claude: 0
    });
    expect(primaryHostPage.status_counts).toEqual({
      all: 1,
      normal: 1,
      error: 0
    });
    expect(primaryHostPage.host_counts.map((entry) => entry.host).sort()).toEqual(
      [new URL(primary.url).host, new URL(compact.url).host, new URL(claude.url).host].sort()
    );

    const normalPrimaryHostParams = new URLSearchParams({
      status: "normal",
      host: new URL(primary.url).host
    });
    const normalPrimaryHostPage = await fetchLogPage(
      app.url,
      `?${normalPrimaryHostParams.toString()}`
    );
    expect(normalPrimaryHostPage.logs).toHaveLength(1);
    expect(normalPrimaryHostPage.counts).toEqual({
      all: 1,
      primary: 1,
      compact: 0,
      claude: 0
    });
    expect(normalPrimaryHostPage.host_counts.map((entry) => entry.host).sort()).toEqual(
      [new URL(primary.url).host, new URL(claude.url).host].sort()
    );
    expect(JSON.stringify(allPage)).not.toContain("do not expose");
    expect(primaryHostPage.logs[0]).toMatchObject({
      incoming_request_body: null,
      upstream_request_body: null,
      upstream_response_body: null
    });
  });


  it("captures full proxied request and response bodies when enabled", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);

    const primary = await startJsonUpstream({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "PRIMARY_CAPTURE_REPLY" }]
        }
      ]
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "capture me fully"
    });

    expect(response.status).toBe(200);
    await response.text();

    const captures = await waitForCaptureRecords(captureDir, 1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      route: "primary",
      source_model: "gpt-5.5",
      target_model: "gpt-5.5",
      compact_bridge_replacements: 0
    });
    expect(captures[0].incoming_request.body.text).toContain("capture me fully");
    expect(captures[0].upstream_request.body.text).toContain("capture me fully");
    expect(captures[0].upstream_response.body.text).toContain("PRIMARY_CAPTURE_REPLY");
    expect(captures[0].incoming_request.body.truncated).toBe(false);
    expect(captures[0].upstream_request.body.truncated).toBe(false);
    expect(captures[0].upstream_response.body.truncated).toBe(false);
  });

  it("redacts credential query values and Cookie headers in stored diagnostics", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);
    const primary = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "upstream-session=response-secret"
      });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(
      app.url,
      "/v1/responses?api_key=query-secret&api-version=2026-07-16",
      { model: "gpt-5.5", input: "redact local diagnostics" },
      { cookie: "session=request-secret" }
    );
    expect(response.status).toBe(200);
    await response.text();

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry.path).not.toContain("query-secret");
    expect(new URL(entry.path, app.url).searchParams.get("api_key")).toBe("[redacted]");
    expect(entry.path).toContain("api-version=2026-07-16");

    const [capture] = await waitForCaptureRecords(captureDir, 1);
    expect(JSON.stringify(capture)).not.toContain("query-secret");
    expect(capture.path).toContain("api-version=2026-07-16");
    expect(new URL(capture.upstream_url).searchParams.get("api_key")).toBe("[redacted]");
    expect(capture.incoming_request.headers.cookie).toBe("[redacted]");
    expect(capture.upstream_request.headers.cookie).toBe("[redacted]");
    expect(capture.upstream_response.headers["set-cookie"]).toBe("[redacted]");
  });

  it("bounds captured body payloads while preserving original byte lengths", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);
    setEnv("COMPACTGATE_CAPTURE_BODY_MAX_BYTES", "12");

    const primary = await startJsonUpstream({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "RESPONSE_SHOULD_BE_TRUNCATED" }]
        }
      ]
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "REQUEST_SHOULD_BE_TRUNCATED"
    });

    expect(response.status).toBe(200);
    await response.text();

    const [capture] = await waitForCaptureRecords(captureDir, 1);
    expect(capture.incoming_request.body).toMatchObject({
      captured_byte_length: 12,
      truncated: true
    });
    expect(capture.upstream_request.body).toMatchObject({
      captured_byte_length: 12,
      truncated: true
    });
    expect(capture.upstream_response.body).toMatchObject({
      captured_byte_length: 12,
      truncated: true
    });
    expect(capture.incoming_request.body.byte_length).toBeGreaterThan(12);
    expect(capture.upstream_response.body.byte_length).toBeGreaterThan(12);
    expect(JSON.stringify(capture)).not.toContain("REQUEST_SHOULD_BE_TRUNCATED");
    expect(JSON.stringify(capture)).not.toContain("RESPONSE_SHOULD_BE_TRUNCATED");
  });

  it("ignores malformed debug capture body byte limits", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);
    setEnv("COMPACTGATE_CAPTURE_BODY_MAX_BYTES", "12abc");

    const primary = await startJsonUpstream({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "RESPONSE_SHOULD_REMAIN_VISIBLE" }]
        }
      ]
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url);

    const response = await postJson(app.url, "/v1/responses", {
      model: "gpt-5.5",
      input: "REQUEST_SHOULD_REMAIN_VISIBLE"
    });

    expect(response.status).toBe(200);
    await response.text();

    const [capture] = await waitForCaptureRecords(captureDir, 1);
    expect(capture.incoming_request.body.truncated).toBe(false);
    expect(capture.upstream_request.body.truncated).toBe(false);
    expect(capture.upstream_response.body.truncated).toBe(false);
    expect(JSON.stringify(capture)).toContain("REQUEST_SHOULD_REMAIN_VISIBLE");
    expect(JSON.stringify(capture)).toContain("RESPONSE_SHOULD_REMAIN_VISIBLE");
  });

  it("persists all SQLite logs across restarts and pages the visible list", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream({ ok: true });

    const firstApp = await startAppInDir(dir, primary.url, compact.url, {
      logging: { keep_recent: 2 }
    });

    await sendCompactRequest(firstApp.url, "gpt-5.3");
    await sendCompactRequest(firstApp.url, "gpt-5.4");
    await sendCompactRequest(firstApp.url, "gpt-5.5");

    const firstLogs = await fetchRecentLogs(firstApp.url);
    expect(firstLogs).toHaveLength(2);
    expect(firstLogs.map((entry) => entry.source_model)).toEqual(["gpt-5.5", "gpt-5.4"]);
    const firstPage = await fetchLogPage(firstApp.url);
    expect(firstPage.total).toBe(3);
    expect(firstPage.all_total).toBe(3);
    expect(firstPage.provider_counts).toEqual({
      all: 3,
      openai: 3,
      claude: 0
    });
    expect(firstPage.has_more).toBe(true);

    const oversizedPage = await fetchLogPage(firstApp.url, "?limit=999");
    expect(oversizedPage.limit).toBe(2);
    expect(oversizedPage.logs).toHaveLength(2);
    expect(oversizedPage.logs.map((entry) => entry.source_model)).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(oversizedPage.total).toBe(3);
    expect(oversizedPage.has_more).toBe(true);

    const unsafeOffsetPage = await fetchLogPage(firstApp.url, "?limit=1&offset=999999999999999999999999999999");
    expect(unsafeOffsetPage.offset).toBe(0);
    expect(unsafeOffsetPage.logs).toHaveLength(1);
    expect(unsafeOffsetPage.logs[0].source_model).toBe("gpt-5.5");
    expect(unsafeOffsetPage.total).toBe(3);
    expect(unsafeOffsetPage.has_more).toBe(true);

    const malformedNumericPage = await fetchLogPage(firstApp.url, "?limit=1abc&offset=2abc");
    expect(malformedNumericPage.limit).toBe(2);
    expect(malformedNumericPage.offset).toBe(0);
    expect(malformedNumericPage.logs.map((entry) => entry.source_model)).toEqual(["gpt-5.5", "gpt-5.4"]);

    await firstApp.close();

    const restartedApp = await startAppInDir(dir, primary.url, compact.url, {
      logging: { keep_recent: 2 }
    });
    const restartedLogs = await fetchRecentLogs(restartedApp.url);

    expect(restartedLogs).toHaveLength(2);
    expect(restartedLogs.map((entry) => entry.source_model)).toEqual(["gpt-5.5", "gpt-5.4"]);
    const olderPage = await fetchLogPage(restartedApp.url, "?limit=2&offset=2");
    expect(olderPage.logs).toHaveLength(1);
    expect(olderPage.logs[0].source_model).toBe("gpt-5.3");
    expect(olderPage.total).toBe(3);
    expect(olderPage.has_more).toBe(false);
    expect(JSON.stringify(restartedLogs)).not.toContain("sensitive prompt");
  });

  it("ignores COMPACTGATE_LOG_DB and always writes the config-derived log database", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const overrideDbPath = path.join(dir, "runtime", "override-logs.sqlite");
    process.env.COMPACTGATE_LOG_DB = overrideDbPath;
    cleanupEnvKeys.add("COMPACTGATE_LOG_DB");

    const primary = await startUpstream((_req, res) => res.end("{}"));
    const compact = await startJsonUpstream({ ok: true });
    const app = await startAppInDir(dir, primary.url, compact.url);

    await sendCompactRequest(app.url, "gpt-5.6");

    const page = await fetchLogPage(app.url);
    expect(page.provider_counts).toEqual({
      all: 1,
      openai: 1,
      claude: 0
    });
    expect(page.logs[0].source_model).toBe("gpt-5.6");
    expect("storage" in page).toBe(false);

    const defaultDbCount = readLogCount(path.join(dir, "compactgate-logs.sqlite"));
    expect(defaultDbCount).toBe(1);
    expect(() => readLogCount(overrideDbPath)).toThrow();
  });

  it("migrates older SQLite log databases with usage metric defaults", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-app-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    seedLegacyLogDatabase(path.join(dir, "compactgate-logs.sqlite"));

    const app = await startAppInDir(dir);
    const [entry] = await fetchRecentLogs(app.url);

    expect(entry).toMatchObject({
      route: "compact",
      path: "/v1/responses/compact",
      endpoint: "/responses/compact",
      request_type: "http",
      incoming_request_body: null,
      upstream_request_body: null,
      upstream_response_body: null,
      input_tokens: null,
      output_tokens: null,
      cached_input_tokens: null,
      cached_output_tokens: null,
      reasoning_tokens: null,
      additive_cached_input_tokens: false,
      additive_cached_output_tokens: false,
      total_tokens: null
    });
  });
});
