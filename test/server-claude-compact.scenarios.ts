import { describe, expect, it } from "vitest";
import {
  captureBody,
  type CapturedRequest,
  claudeManualCompactPrompt,
  fetchLogPage,
  setEnv,
  startApp,
  startClaudeUpstream
} from "./helpers/server-test-utils.js";

const CLAUDE_HEADERS = {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01"
};

async function startCapturedClaudeUpstream(
  requests: CapturedRequest[],
  responseBody: unknown
) {
  return startClaudeUpstream(async (req, res) => {
    requests.push({
      method: req.method ?? "POST",
      url: req.url ?? "",
      headers: req.headers,
      body: await captureBody(req)
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  });
}

function postClaudeMessage(appUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: CLAUDE_HEADERS
  });
}

describe("CompactGate Claude routing", () => {
  it("keeps Claude Code manual compact requests on the Claude primary route without a prior arm", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startCapturedClaudeUpstream(primaryRequests, {
      type: "message",
      usage: { input_tokens: 2, output_tokens: 3 }
    });
    const claudeCompact = await startCapturedClaudeUpstream(compactRequests, {
      type: "message",
      usage: { input_tokens: 5, output_tokens: 7 }
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const manualCompactPrompt = [
      "Your task is to create a detailed summary of the conversation so far.",
      "CRITICAL: Respond with TEXT ONLY.",
      "<summary>",
      "Include the full context needed to continue.",
      "</summary>"
    ].join("\n");
    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages?beta=true", {
      model: "claude-opus-4-8",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: manualCompactPrompt }]
        }
      ]
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("claude");
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(response.headers.get("x-compactgate-claude-retry")).toBeNull();
    await response.text();

    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].url).toBe("/v1/messages?beta=true");
    expect(primaryRequests[0].headers["anthropic-api-key"]).toBe("saved-claude-primary-token");
    expect(primaryRequests[0].body).toContain("Your task is to create a detailed summary");

    const page = await fetchLogPage(app.url);
    expect(page.logs[0]).toMatchObject({
      route: "claude",
      status: 200,
      upstream_host: new URL(claudePrimary.url).host
    });
  });

  it("keeps manual Claude compact requests on the primary route after a large AnyRouter reconnect", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startCapturedClaudeUpstream(primaryRequests, {
      type: "message",
      content: [{ type: "text", text: "PRIMARY_OK" }]
    });
    const claudeCompact = await startCapturedClaudeUpstream(compactRequests, {
      type: "message",
      content: [{ type: "text", text: "COMPACT_OK" }]
    });
    setEnv("COMPACTGATE_CLAUDE_ANYROUTER_COMPACT_BYTES", "256");
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: `${claudePrimary.url}/anyrouter`,
          api_key: "saved-claude-primary-token"
        },
        model_map: {
          default: "mapped-claude-default",
          opus: "mapped-claude-opus",
          sonnet: "",
          haiku: "",
          reasoning: "",
          subagent: ""
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split",
          model_override: "claude-compact-manual"
        }
      }
    });

    const armingResponse = await postClaudeMessage(app.url, "/anthropic/v1/messages?beta=true", {
      model: "claude-primary-model",
      metadata: { reconnect_count: 3 },
      messages: [{ role: "user", content: "large AnyRouter context ".repeat(40) }]
    });
    expect(armingResponse.status).toBe(200);
    expect(armingResponse.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(await armingResponse.text()).toContain("PRIMARY_OK");
    expect(primaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[0].url).toBe("/anyrouter/v1/messages?beta=true");
    expect(primaryRequests[0].headers["anthropic-api-key"]).toBe("saved-claude-primary-token");

    const manualCompactPrompt = [
      "Your task is to create a detailed summary of the conversation so far.",
      "CRITICAL: Respond with TEXT ONLY.",
      "<summary>",
      "Summarize the previous context.",
      "</summary>"
    ].join("\n");
    const compactResponse = await postClaudeMessage(app.url, "/anthropic/v1/messages?beta=true", {
      model: "claude-original-manual",
      messages: [{ role: "user", content: [{ type: "text", text: manualCompactPrompt }] }]
    });

    expect(compactResponse.status).toBe(200);
    expect(compactResponse.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(compactResponse.headers.get("x-compactgate-claude-retry")).toBeNull();
    expect(await compactResponse.text()).toContain("PRIMARY_OK");
    expect(primaryRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests[1].url).toBe("/anyrouter/v1/messages?beta=true");
    expect(primaryRequests[1].headers["anthropic-api-key"]).toBe("saved-claude-primary-token");
    expect(JSON.parse(primaryRequests[1].body).model).toBe("mapped-claude-default");
    expect(primaryRequests[1].body).toContain("Your task is to create a detailed summary");

    const secondCompactResponse = await postClaudeMessage(app.url, "/anthropic/v1/messages?beta=true", {
      model: "claude-original-manual",
      messages: [{ role: "user", content: [{ type: "text", text: manualCompactPrompt }] }]
    });

    expect(secondCompactResponse.status).toBe(200);
    expect(secondCompactResponse.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(await secondCompactResponse.text()).toContain("PRIMARY_OK");
    expect(primaryRequests).toHaveLength(3);
    expect(compactRequests).toHaveLength(0);
    expect(JSON.parse(primaryRequests[2].body).model).toBe("mapped-claude-default");
  });

  it("keeps manual Claude compact requests on primary when reconnect count is below threshold", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startCapturedClaudeUpstream(primaryRequests, {
      type: "message",
      content: [{ type: "text", text: "PRIMARY_OK" }]
    });
    const claudeCompact = await startCapturedClaudeUpstream(compactRequests, {
      type: "message",
      content: [{ type: "text", text: "COMPACT_OK" }]
    });
    setEnv("COMPACTGATE_CLAUDE_ANYROUTER_COMPACT_BYTES", "128");
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: `${claudePrimary.url}/anyrouter`,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const armingResponse = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-primary-model",
      metadata: { reconnect_count: 2 },
      messages: [{ role: "user", content: "large AnyRouter context ".repeat(40) }]
    });
    await armingResponse.text();

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: claudeManualCompactPrompt() }] }]
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(primaryRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(0);
  });

  it("keeps manual Claude compact requests on primary when the reconnect body is small", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startCapturedClaudeUpstream(primaryRequests, {
      type: "message",
      content: [{ type: "text", text: "PRIMARY_OK" }]
    });
    const claudeCompact = await startCapturedClaudeUpstream(compactRequests, {
      type: "message",
      content: [{ type: "text", text: "COMPACT_OK" }]
    });
    setEnv("COMPACTGATE_CLAUDE_ANYROUTER_COMPACT_BYTES", "10000");
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: `${claudePrimary.url}/anyrouter`,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const armingResponse = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-primary-model",
      metadata: { reconnect_count: 3 },
      messages: [{ role: "user", content: "small context" }]
    });
    await armingResponse.text();

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: claudeManualCompactPrompt() }] }]
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(primaryRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(0);
  });

  it("keeps manual Claude compact requests on primary for non-AnyRouter Claude upstreams", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startCapturedClaudeUpstream(primaryRequests, {
      type: "message",
      content: [{ type: "text", text: "PRIMARY_OK" }]
    });
    const claudeCompact = await startCapturedClaudeUpstream(compactRequests, {
      type: "message",
      content: [{ type: "text", text: "COMPACT_OK" }]
    });
    setEnv("COMPACTGATE_CLAUDE_ANYROUTER_COMPACT_BYTES", "128");
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: claudePrimary.url,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const armingResponse = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-primary-model",
      metadata: { reconnect_count: 3 },
      messages: [{ role: "user", content: "large non AnyRouter context ".repeat(40) }]
    });
    await armingResponse.text();

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: claudeManualCompactPrompt() }] }]
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(primaryRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(0);
  });

  it("keeps manual Claude compact requests on primary with non-exact reconnect fields", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const claudePrimary = await startCapturedClaudeUpstream(primaryRequests, {
      type: "message",
      content: [{ type: "text", text: "PRIMARY_OK" }]
    });
    const claudeCompact = await startCapturedClaudeUpstream(compactRequests, {
      type: "message",
      content: [{ type: "text", text: "COMPACT_OK" }]
    });
    setEnv("COMPACTGATE_CLAUDE_ANYROUTER_COMPACT_BYTES", "128");
    const app = await startApp(undefined, undefined, {
      claude: {
        primary: {
          base_url: `${claudePrimary.url}/anyrouter`,
          api_key: "saved-claude-primary-token"
        },
        compact: {
          base_url: claudeCompact.url,
          api_key: "saved-claude-compact-token",
          upstream_mode: "split"
        }
      }
    });

    const armingResponse = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-primary-model",
      metadata: { reconnect: { count: 5 } },
      messages: [{ role: "user", content: "large AnyRouter context ".repeat(40) }]
    });
    await armingResponse.text();

    const response = await postClaudeMessage(app.url, "/anthropic/v1/messages", {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: claudeManualCompactPrompt() }] }]
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-claude-route")).toBe("primary");
    expect(primaryRequests).toHaveLength(2);
    expect(compactRequests).toHaveLength(0);
  });
});
