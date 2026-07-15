import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      res.end(
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
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: claude.url,
        api_key: "saved-claude-token"
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
    expect(captured.current.body).toContain("capture claude");

    const entry = await waitForLogEntry(app.url, (e) => e.route === "claude");
    expect(entry).toMatchObject({
      route: "claude",
      endpoint: "/messages",
      request_type: "stream",
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
    expect(captures[0].incoming_request.headers.authorization).toBe("[redacted]");
    expect(JSON.stringify(captures[0])).not.toContain("saved-claude-token");
    expect(JSON.stringify(captures[0])).not.toContain("client-token");
  });
});
