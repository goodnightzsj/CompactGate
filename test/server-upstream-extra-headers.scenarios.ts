import { describe, expect, it } from "vitest";
import {
  assertCaptured,
  type CapturedRequest,
  postJson,
  startApp,
  startCapturedOpenAiUpstream,
  startClaudeUpstream,
  captureRequest,
  writeJsonResponse
} from "./helpers/server-test-utils.js";

describe("configured upstream extra headers", () => {
  it("forwards selected route headers and lets config override ordinary client values", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (_req, res) => {
      writeJsonResponse(res, { id: "resp_primary", object: "response", output: [] });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (_req, res) => {
      writeJsonResponse(res, { output: [] });
    });
    const claudeCapture: { current: CapturedRequest | null } = { current: null };
    const claude = await startClaudeUpstream(async (req, res) => {
      claudeCapture.current = await captureRequest(req);
      writeJsonResponse(res, {
        type: "message",
        content: [{ type: "text", text: "ok" }]
      });
    });
    const app = await startApp(primary.url, compact.url, {
      primary: {
        api_key: "primary-key",
        extra_headers: { "x-route-secret": "primary-secret" }
      },
      compact: {
        api_key: "compact-key",
        extra_headers: { "x-route-secret": "compact-secret" }
      },
      claude: {
        primary: {
          base_url: claude.url,
          api_key: "claude-key",
          extra_headers: { "x-route-secret": "claude-secret" }
        }
      }
    });

    expect((await postJson(app.url, "/v1/responses", {
      model: "gpt-5",
      input: "primary"
    }, { "x-route-secret": "client-value" })).status).toBe(200);
    expect((await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5",
      input: "compact"
    }, { "x-route-secret": "client-value" })).status).toBe(200);
    expect((await postJson(app.url, "/anthropic/v1/messages", {
      model: "claude-sonnet-4-6",
      max_tokens: 32,
      messages: [{ role: "user", content: "claude" }]
    }, { "x-route-secret": "client-value" })).status).toBe(200);

    expect(primaryRequests[0]?.headers["x-route-secret"]).toBe("primary-secret");
    expect(primaryRequests[0]?.headers.authorization).toBe("Bearer primary-key");
    expect(compactRequests[0]?.headers["x-route-secret"]).toBe("compact-secret");
    expect(compactRequests[0]?.headers.authorization).toBe("Bearer compact-key");
    assertCaptured(claudeCapture.current);
    expect(claudeCapture.current.headers["x-route-secret"]).toBe("claude-secret");
    expect(claudeCapture.current.headers["anthropic-api-key"]).toBe("claude-key");
  });

  it("uses primary transport headers for compact upstream_mode=primary", async () => {
    const requests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(requests, (_req, res) => {
      writeJsonResponse(res, { output: [] });
    });
    const app = await startApp(primary.url, undefined, {
      primary: {
        api_key: "primary-key",
        extra_headers: { "x-route-secret": "primary-secret" }
      },
      compact: {
        upstream_mode: "primary",
        extra_headers: { "x-route-secret": "unused-compact-secret" }
      },
      primary_failover: { auto_schedule: false }
    });

    const response = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5",
      input: "compact through primary"
    });

    expect(response.status).toBe(200);
    expect(requests[0]?.headers["x-route-secret"]).toBe("primary-secret");
    expect(requests[0]?.headers.authorization).toBe("Bearer primary-key");
  });
});
