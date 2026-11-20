import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import { afterEach, expect, it, vi } from "vitest";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { captureRequest, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

it.each(["native", "oauth"].flatMap(kind => ["\n", "\r\n", "\r"].map(newline => ({ kind, newline }))))(
  "recovers a completed $kind checkpoint with $newline line endings", async ({ kind, newline }) => {
    const requests: Record<string, unknown>[] = [];
    const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recorded eu-west-2." }] };
    let source = "";
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body);
      requests.push(body);
      if (body.previous_response_id) {
        writeJsonResponse(res, { error: { type: "invalid_request_error", code: "previous_response_not_found", message: "Synthetic missing continuation" } }, 400);
        return;
      }
      const events = [
        { type: "response.created", response: { id: "resp_line_endings", status: "in_progress", output: [] } },
        { type: kind === "oauth" ? "response.done" : "response.completed", response: { id: "resp_line_endings", status: "completed", output: [answer] } }
      ];
      source = events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join("");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(source);
    });
    let app;
    if (kind === "oauth") {
      vi.spyOn(https, "request").mockImplementation(((target: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) =>
        http.request(new URL(target.pathname + target.search, upstream.url), {
          ...options, agent: undefined, headers: { ...options.headers, host: target.host }
        }, callback)) as typeof https.request);
      const issuer = oauthTestProvider("openai-codex");
      app = await startApp(undefined, undefined, { primary_failover: { auto_schedule: false, state_recovery_retention_hours: 1 } }, issuer);
      const account = await issuer.authorize(app.config.oauth);
      await app.config.saveOAuthProfile("codex", account, "Synthetic OAuth", "synthetic-model", app.config.revision);
      await app.config.applyProfile("codex", app.config.toPublicConfig().profile_scopes.codex.profiles[0].id);
    } else {
      app = await startApp(upstream.url, upstream.url, { primary_failover: { auto_schedule: false, state_recovery_retention_hours: 1 } });
    }
    const headers = { "x-compactgate-session": "line-ending-checkpoint" };
    const first = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: "Remember eu-west-2.", stream: false }, headers);
    const text = await first.text();
    expect(first.status).toBe(200);
    if (kind === "native") expect(text).toBe(source);
    else expect(JSON.parse(text)).toMatchObject({ id: "resp_line_endings", status: "completed", output: [answer] });
    const log = await waitForLogEntry(app.url, entry => entry.request_id === first.headers.get("x-compactgate-request-id"));
    expect(log.stream_outcome).toBe("success");
    const next = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: "Which region?", previous_response_id: "resp_line_endings", stream: false }, headers);
    await next.text();
    expect(next.status).toBe(200);
    expect(requests).toHaveLength(3);
    const user = (text: string) => ({ type: "message", role: "user",
      content: kind === "oauth" ? [{ type: "input_text", text }] : text });
    expect(requests[2].input).toEqual([user("Remember eu-west-2."), answer, user("Which region?")]);
  }
);
