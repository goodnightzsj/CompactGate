import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sseDataFrames } from "../src/server/sse-frames.js";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

const cases = [false, true].flatMap(stream => [0, 1].flatMap(retention =>
  ["success", "error", "failed-empty", "failed-retained", "incomplete", "error-envelope"].map(terminal => ({ stream, retention, terminal }))));

it.each(cases)("accounts for late $terminal with stream=$stream and retention=$retention", async ({ stream, retention, terminal }) => {
  let attempts = 0;
  const upstream = await startUpstream(async (req, res) => {
    attempts += 1;
    await captureBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const error = { type: "server_error", code: "server_error", message: "Synthetic late source failure." };
    const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }];
    const events: unknown[] = [{ type: "response.done", response: { id: "resp_synthetic", status: "completed", output } }];
    if (terminal !== "success") events.push(terminal === "error" ? { type: "error", error } : {
      type: "response.done", response: {
        status: terminal === "incomplete" ? "incomplete" : terminal === "error-envelope" ? "completed" : "failed",
        output: terminal === "failed-empty" ? [] : output,
        ...(terminal === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : { error })
      }
    });
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
    http.request(new URL(target.pathname + target.search, upstream.url), { ...options, agent: undefined,
      headers: { ...options.headers, host: target.host } }, callback)) as typeof https.request);
  const issuer = oauthTestProvider("openai-codex");
  const app = await startApp(undefined, undefined, { primary_failover: { auto_schedule: false, state_recovery_retention_hours: retention } }, issuer);
  const account = await issuer.authorize(app.config.oauth);
  await app.config.saveOAuthProfile("codex", account, "Synthetic OAuth", "synthetic-model", app.config.revision);
  await app.config.applyProfile("codex", app.config.toPublicConfig().profile_scopes.codex.profiles[0].id);
  const response = await postJson(app.url, "/v1/responses", { model: "synthetic-model", stream, input: "Hello." }, {
    "x-compactgate-session": "synthetic-r4-source-error"
  });
  const body = await response.text();
  expect(response.status).toBe(200);
  expect(body).toContain("Done.");
  if (stream) expect(sseDataFrames(body).map(data => JSON.parse(data).type)).toEqual(["response.completed"]);
  else expect(JSON.parse(body).status).toBe("completed");
  const log = await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
  const db = new DatabaseSync(path.join(app.dir, "compactgate-logs.sqlite"), { readOnly: true });
  let successes: number;
  let checkpoints: number;
  try {
    successes = Number(db.prepare("SELECT COUNT(*) AS n FROM provider_state_recovery_evidence WHERE evidence_kind='target_health'").get()?.n);
    checkpoints = Number(db.prepare("SELECT COUNT(*) AS n FROM provider_state_checkpoints").get()?.n);
  } finally { db.close(); }
  const succeeded = terminal === "success";
  expect({ attempts, outcome: log.stream_outcome, successes, checkpoints }).toEqual({
    attempts: 1, outcome: succeeded ? "success" : "upstream_stream_incomplete",
    successes: succeeded ? 1 : 0, checkpoints: succeeded ? retention : 0
  });
});
