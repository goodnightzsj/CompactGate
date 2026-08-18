import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertCaptured,
  type CapturedRequest,
  cleanup,
  setEnv,
  startApp,
  waitForCaptureRecords,
  waitForLogEntry
} from "./helpers/server-test-utils.js";
import {
  CLAUDE_HEADERS,
  postClaudeMessage,
  startCapturedClaudeUpstream
} from "./server-claude-core-helpers.js";

describe("CompactGate Claude routing", () => {
  it("proxies Claude requests, records Anthropic usage, and redacts captured credentials", async () => {
    const captureDir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-"));
    cleanup.push(() => rm(captureDir, { recursive: true, force: true }));
    setEnv("COMPACTGATE_CAPTURE_DIR", captureDir);

    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startCapturedClaudeUpstream(captured, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: 28_032,
              cache_creation_input_tokens: 11,
              output_tokens: 1
            }
          }
        })}\n\n`
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: {
            input_tokens: 0,
            cache_read_input_tokens: 28_032,
            cache_creation_input_tokens: 11,
            output_tokens: 202,
            output_tokens_details: {
              reasoning_tokens: 159
            }
          }
        })}\n\n`
      );
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token",
        extra_headers: { "x-capture-secret": "configured-capture-secret" }
      }
    });

    const response = await postClaudeMessage(
      app.url,
      "/anthropic/v1/messages?beta=true",
      {
        model: "claude-opus-4-8",
        stream: true,
        messages: [{ role: "user", content: "capture claude" }]
      },
      {
        ...CLAUDE_HEADERS,
        authorization: "Bearer client-token"
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("claude");
    expect(await response.text()).toContain("message_start");
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/messages?beta=true");
    expect(captured.current.headers.authorization).toBe("Bearer saved-claude-token");
    expect(captured.current.headers["x-api-key"]).toBe("saved-claude-token");
    expect(captured.current.headers["anthropic-api-key"]).toBe("saved-claude-token");
    expect(captured.current.headers["x-capture-secret"]).toBe("configured-capture-secret");
    expect(captured.current.body).toContain("capture claude");

    const entry = await waitForLogEntry(app.url, (e) => e.route === "claude");
    expect(entry).toMatchObject({
      route: "claude",
      endpoint: "/v1/messages",
      request_type: "stream",
      status: 200,
      upstream_status: 200,
      stream_terminal_event: "message_stop",
      stream_outcome: "success",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8",
      response_model: "claude-opus-4-8",
      input_tokens: 0,
      output_tokens: 202,
      cached_input_tokens: 28_043,
      cache_read_input_tokens: 28_032,
      cache_creation_input_tokens: 11,
      reasoning_tokens: 159,
      additive_cached_input_tokens: true,
      additive_cached_output_tokens: false,
      total_tokens: 28_245
    });

    const captures = await waitForCaptureRecords(captureDir, 1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      route: "claude",
      source_model: "claude-opus-4-8",
      target_model: "claude-opus-4-8"
    });
    expect(captures[0].upstream_request.headers.authorization).toBe("[redacted]");
    expect(captures[0].upstream_request.headers["x-api-key"]).toBe("[redacted]");
    expect(captures[0].upstream_request.headers["anthropic-api-key"]).toBe("[redacted]");
    expect(captures[0].upstream_request.headers["x-capture-secret"]).toBe("[redacted]");
    expect(captures[0].incoming_request.headers.authorization).toBe("[redacted]");
    expect(JSON.stringify(captures[0])).not.toContain("saved-claude-token");
    expect(JSON.stringify(captures[0])).not.toContain("client-token");
    expect(JSON.stringify(captures[0])).not.toContain("configured-capture-secret");
  });

  it("records complete Brotli Anthropic streams without changing the client response", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const stream = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          model: "claude-sonnet-br",
          usage: { input_tokens: 13, output_tokens: 1 }
        }
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 8 }
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    ].join("");
    const claude = await startCapturedClaudeUpstream(captured, (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "br"
      });
      res.end(brotliCompressSync(Buffer.from(stream)));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-sonnet-br",
      stream: true,
      messages: [{ role: "user", content: "brotli claude" }]
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
    const entry = await waitForLogEntry(app.url, (candidate) => candidate.route === "claude");
    expect(entry).toMatchObject({
      status: 200,
      upstream_status: 200,
      stream_terminal_event: "message_stop",
      stream_outcome: "success",
      upstream_response_truncated: false,
      response_model: "claude-sonnet-br",
      input_tokens: 13,
      output_tokens: 8,
      total_tokens: 21,
      error_summary: null
    });
  });

  it("keeps Brotli non-streaming Claude JSON responses successful without message_stop", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const message = {
      id: "msg_non_streaming_br",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-json-br",
      content: [{ type: "text", text: "complete" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 17, output_tokens: 9 }
    };
    const claude = await startCapturedClaudeUpstream(captured, (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-encoding": "br"
      });
      res.end(brotliCompressSync(Buffer.from(JSON.stringify(message))));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages?beta=true", {
      model: "claude-sonnet-json-br",
      messages: [{ role: "user", content: "non-streaming claude" }]
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      stop_reason: "end_turn"
    });
    const entry = await waitForLogEntry(app.url, (candidate) => candidate.route === "claude");
    expect(entry).toMatchObject({
      request_type: "http",
      status: 200,
      upstream_status: 200,
      stream_terminal_event: null,
      stream_outcome: "success",
      upstream_response_truncated: false,
      response_model: "claude-sonnet-json-br",
      input_tokens: 17,
      output_tokens: 9,
      total_tokens: 26,
      error_summary: null
    });
  });

  it("records an HTTP 200 Anthropic error event as a provider stream error", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startCapturedClaudeUpstream(captured, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: error\ndata: ${JSON.stringify({
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Overloaded"
        }
      })}\n\n`);
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-sonnet-test",
      stream: true,
      messages: [{ role: "user", content: "provider error" }]
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("overloaded_error");
    const entry = await waitForLogEntry(app.url, (candidate) => candidate.route === "claude");
    expect(entry).toMatchObject({
      status: 200,
      upstream_status: 200,
      stream_terminal_event: "error",
      stream_outcome: "upstream_stream_error",
      error_summary: "Overloaded (overloaded_error)"
    });
  });

  it("keeps a clean EOF before message_stop classified as incomplete", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const claude = await startCapturedClaudeUpstream(captured, (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" }
      })}\n\n`);
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
      }
    });

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-sonnet-test",
      stream: true,
      messages: [{ role: "user", content: "partial stream" }]
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("partial");
    const entry = await waitForLogEntry(app.url, (candidate) => candidate.route === "claude");
    expect(entry).toMatchObject({
      status: 200,
      upstream_status: 200,
      stream_terminal_event: null,
      stream_outcome: "upstream_stream_incomplete",
      error_summary: "Anthropic stream closed before message_stop."
    });
  });
});
