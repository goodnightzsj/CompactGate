import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { captureBody, postJson, startApp, startUpstream } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

const item = { type: "compaction", encrypted_content: "synthetic-context" };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const output = frame({ type: "response.output_item.done", output_index: 0, item });
const done = frame({ type: "response.done", response: { id: "resp_synthetic", status: "completed",
  usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } } });

async function oauthApp(body: string | Buffer, status = 200, encoding?: string) {
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    res.writeHead(status, { "content-type": "text/event-stream", ...(encoding ? { "content-encoding": encoding } : {}) });
    res.end(body);
  });
  vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
    http.request(new URL(target.pathname + target.search, upstream.url), {
      ...options, agent: undefined, headers: { ...options.headers, host: target.host }
    }, callback)) as typeof https.request);
  const issuer = oauthTestProvider("openai-codex");
  const app = await startApp(undefined, undefined, { primary_failover: { auto_schedule: false } }, issuer);
  const account = await issuer.authorize(app.config.oauth);
  await app.config.saveOAuthProfile("codex", account, "Synthetic OAuth", "synthetic-model", app.config.revision);
  await app.config.applyProfile("codex", app.config.toPublicConfig().profile_scopes.codex.profiles[0].id);
  return app;
}

it("agrees with normal compact on Codex response.done and collected output items", async () => {
  const app = await oauthApp(output + done);
  const normal = await postJson(app.url, "/v1/responses/compact", { model: "synthetic-model", input: "hello", stream: false });
  expect(normal.status).toBe(200);
  expect(await normal.json()).toMatchObject({ status: "completed", output: [item] });
  const result = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic-model" }).then(response => response.json());
  expect(result).toMatchObject({ supported: true, terminal_event: "response.completed", compaction_item_count: 1,
    usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 }, failure_reason: null });
});

it.each([
  ["failed", output + frame({ type: "response.done", response: { status: "failed", error: { message: "Synthetic failure" } } })],
  ["incomplete", output + frame({ type: "response.done", response: { status: "incomplete" } })],
  ["late error", output + done + frame({ type: "error", error: { message: "Synthetic late error" } })],
  ["missing terminal", output],
  ["malformed", output + "data: invalid\n\n" + done],
  ["truncated", output + done + frame({ type: "response.metadata", value: "x".repeat(512 * 1024) })]
])("keeps the OAuth probe unsuccessful for %s", async (_name, body) => {
  const app = await oauthApp(body);
  const result = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic-model" }).then(response => response.json());
  expect(result).toMatchObject({ supported: false, upstream_status: 200, failure_reason: expect.any(String) });
});

it("preserves HTTP errors even with a valid Codex terminal", async () => {
  const app = await oauthApp(output + done, 403);
  const result = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic-model" }).then(response => response.json());
  expect(result).toMatchObject({ supported: false, upstream_status: 403, failure_reason: expect.any(String) });
});

it("preserves the Codex identity-encoding contract", async () => {
  const app = await oauthApp(gzipSync(output + done), 200, "gzip");
  const result = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic-model" }).then(response => response.json());
  expect(result).toMatchObject({ supported: false, upstream_status: 200,
    failure_reason: "Codex ignored the identity encoding request." });
});

it("does not accept response.done from ordinary Responses providers", async () => {
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(output + done);
  });
  const app = await startApp(upstream.url, upstream.url);
  const result = await postJson(app.url, "/api/compact/capability-probe", { model: "synthetic-model" }).then(response => response.json());
  expect(result.supported).toBe(false);
});
