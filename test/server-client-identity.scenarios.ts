import { describe, expect, it } from "vitest";
import type { ClientIdentityStatus } from "../src/shared/types.js";
import { factoryClientUserAgent } from "../src/server/config-defaults.js";
import {
  fetchJson,
  startApp,
  startClaudeUpstream,
  startUpstream
} from "./helpers/server-test-utils.js";

/**
 * A real third-party client seen in this project's own request log. It is the
 * exact case the feature exists for: a client that no whitelisting relay
 * recognises.
 */
const THIRD_PARTY_HEADERS = {
  "content-type": "application/json",
  "user-agent": "pi (darwin 24.0.0; arm64)",
  "x-stainless-lang": "js",
  session_id: "01a05cf1-be98-7518-b7af-0354643fd621"
};

const CODEX_CLI_USER_AGENT =
  "codex-tui/0.144.1-cometix (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.1-cometix)";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.234 (external, cli)";

describe("CompactGate client identity", () => {
  it("rewrites only the user-agent for a non-CLI client on the OpenAI route", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const primary = await startUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", model: "gpt-5" }));
    });
    const app = await startApp(primary.url);

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: THIRD_PARTY_HEADERS,
      body: JSON.stringify({ model: "gpt-5", input: [] })
    });

    expect(response.status).toBe(200);
    expect(seen["user-agent"]).toBe(factoryClientUserAgent("codex"));
    // Everything the client sent besides the agent has to arrive untouched —
    // the whole point of the narrowed scope.
    expect(seen["x-stainless-lang"]).toBe("js");
    expect(seen.session_id).toBe("01a05cf1-be98-7518-b7af-0354643fd621");
  });

  it("leaves a real Codex CLI request's user-agent alone", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const primary = await startUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", model: "gpt-5" }));
    });
    const app = await startApp(primary.url);

    await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": CODEX_CLI_USER_AGENT },
      body: JSON.stringify({ model: "gpt-5", input: [] })
    });

    expect(seen["user-agent"]).toBe(CODEX_CLI_USER_AGENT);
    // That same request is what feeds the extracted source, minus the fork tag.
    const { body: status } = await fetchJson<ClientIdentityStatus>(
      `${app.url}/api/client-identity`,
      "GET"
    );
    expect(status.codex.extracted.user_agent).toBe(
      "codex-tui/0.144.1 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.1)"
    );
    expect(status.resolved.codex.source).toBe("extracted");
  });

  it("sends the Claude agent on the Anthropic route and learns from the real CLI", async () => {
    const agents: Array<string | undefined> = [];
    const claude = await startClaudeUpstream((req, res) => {
      agents.push(req.headers["user-agent"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "OK" }] }));
    });
    const app = await startApp(undefined, undefined, {
      claude: { base_url: claude.url, api_key: "claude-token" }
    });

    const body = JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }]
    });
    await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: THIRD_PARTY_HEADERS,
      body
    });
    await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": CLAUDE_CLI_USER_AGENT },
      body
    });

    expect(agents).toEqual([factoryClientUserAgent("claude"), CLAUDE_CLI_USER_AGENT]);
  });

  it("uses the Codex agent when an Anthropic-ingress request leaves as Responses", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const upstream = await startUpstream((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", model: "gpt-5", output: [] }));
    });
    const app = await startApp(undefined, undefined, {
      claude: {
        base_url: `${upstream.url}/v1`,
        api_key: "claude-token",
        upstream_protocol: "openai_responses"
      }
    });

    await fetch(`${app.url}/anthropic/v1/messages`, {
      method: "POST",
      headers: THIRD_PARTY_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }]
      })
    });

    // The wire protocol, not the ingress path, picks the identity.
    expect(seen["user-agent"]).toBe(factoryClientUserAgent("codex"));
  });

  it("stops rewriting when the operator turns it off and honours a manual agent", async () => {
    const agents: Array<string | undefined> = [];
    const primary = await startUpstream((req, res) => {
      agents.push(req.headers["user-agent"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_1", model: "gpt-5" }));
    });
    const app = await startApp(primary.url);
    const send = () => fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: THIRD_PARTY_HEADERS,
      body: JSON.stringify({ model: "gpt-5", input: [] })
    });

    await postIdentity(app.url, { codex: { extracted_user_agent: "codex-cli/9.9.9" } });
    await send();

    await postIdentity(app.url, { enabled: false });
    await send();

    expect(agents).toEqual(["codex-cli/9.9.9", THIRD_PARTY_HEADERS["user-agent"]]);
  });

  it("rejects a user-agent that would inject a second header", async () => {
    const app = await startApp();
    const response = await fetch(`${app.url}/api/client-identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codex: { extracted_user_agent: "evil\r\nx-admin: 1" } })
    });

    expect(response.status).toBe(400);
  });
});

async function postIdentity(appUrl: string, patch: unknown): Promise<ClientIdentityStatus> {
  const response = await fetch(`${appUrl}/api/client-identity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  expect(response.status).toBe(200);
  return await response.json() as ClientIdentityStatus;
}
