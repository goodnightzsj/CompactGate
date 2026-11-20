import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

for (const mode of ["primary", "local", "remote_v1"] as const) {
  it.each(["response.failed", "response.done"])(`${mode}: recovers pre-output encrypted rejection delivered as %s`, async type => {
    const seen: Array<{ input: Array<{ type: string }> }> = [];
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureBody(req)).toString());
      seen.push(body);
      const rejected = body.input.some((item: { type: string }) => item.type === "reasoning");
      const response = rejected ? {
        id: "resp_rejected", status: "failed", output: [],
        error: { type: "invalid_request_error", code: "invalid_encrypted_content", param: "input[0].encrypted_content", message: "The encrypted content could not be decrypted or parsed." }
      } : { id: "resp_success", status: "completed", output: mode === "remote_v1"
        ? [{ type: "compaction", encrypted_content: "synthetic-new-context" }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered." }] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: rejected ? type : "response.done", response })}\n\n`);
    });
    vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
      http.request(new URL(target.pathname + target.search, upstream.url), { ...options, agent: undefined,
        headers: { ...options.headers, host: target.host } }, callback)) as typeof https.request);
    const issuer = oauthTestProvider("openai-codex");
    const app = await startApp(undefined, undefined, { primary_failover: { auto_schedule: false, state_recovery_retention_hours: 0 } }, issuer);
    const account = await issuer.authorize(app.config.oauth);
    await app.config.saveOAuthProfile("codex", account, "Synthetic OAuth", "synthetic-model", app.config.revision);
    await app.config.applyProfile("codex", app.config.toPublicConfig().profile_scopes.codex.profiles[0].id);
    const response = await postJson(app.url, mode === "remote_v1" ? "/v1/responses/compact" : "/v1/responses", {
      model: "synthetic-model", store: false, stream: false,
      input: [{ type: "reasoning", encrypted_content: "rejected-synthetic-state", summary: [] },
        { type: "message", role: "user", content: "Continue." }]
    }, mode === "local" ? { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) } : {});
    const result = await response.json();
    expect({ status: result.status, attempts: seen.length }).toEqual({ status: "completed", attempts: 2 });
    expect(response.headers.get("x-compactgate-state-recovery")).toBe("recovered");
  });
}

it.each([false, true])("does not mark a Codex source error after terminal as healthy (stream=%s)", async stream => {
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      { type: "response.done", response: { id: "resp_synthetic", status: "completed", output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }
      ] } },
      { type: "error", error: { type: "server_error", code: "server_error", message: "Synthetic late source failure." } }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
    http.request(new URL(target.pathname + target.search, upstream.url), { ...options, agent: undefined,
      headers: { ...options.headers, host: target.host } }, callback)) as typeof https.request);
  const issuer = oauthTestProvider("openai-codex");
  const app = await startApp(undefined, undefined, { primary_failover: { auto_schedule: false, state_recovery_retention_hours: 0 } }, issuer);
  const account = await issuer.authorize(app.config.oauth);
  await app.config.saveOAuthProfile("codex", account, "Synthetic OAuth", "synthetic-model", app.config.revision);
  await app.config.applyProfile("codex", app.config.toPublicConfig().profile_scopes.codex.profiles[0].id);
  const response = await postJson(app.url, "/v1/responses", { model: "synthetic-model", stream, input: "Hello." }, {
    "x-compactgate-session": "synthetic-r3-source-error"
  });
  await response.text();
  const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
  const db = new DatabaseSync(path.join(app.dir, "compactgate-logs.sqlite"), { readOnly: true });
  let successes: number;
  try { successes = Number(db.prepare("SELECT COUNT(*) AS n FROM provider_state_recovery_evidence WHERE evidence_kind='target_health'").get()?.n); }
  finally { db.close(); }
  expect({ outcome: log.stream_outcome, successes }).toEqual({ outcome: "upstream_stream_incomplete", successes: 0 });
});
