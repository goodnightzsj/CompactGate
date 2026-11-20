import http, { type IncomingMessage, type RequestOptions } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureRequest, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

const realRequest = http.request;
beforeEach(() => {
  vi.spyOn(http, "request").mockImplementation(((url: URL, options: RequestOptions,
    callback: (response: IncomingMessage) => void) => {
    if (!(url instanceof URL) || url.protocol !== "http:" || !url.port) throw new Error("Only the local fixture is permitted.");
    const target = new URL(url);
    target.hostname = "127.0.0.1";
    return realRequest(target, { ...options, headers: { ...options.headers, host: url.host } }, callback);
  }) as typeof http.request);
});
afterEach(() => vi.restoreAllMocks());

it.each(["relay.example", "agentrouter.org"].flatMap(host =>
  ["invalid_responses_request", "invalid_encrypted_content"].map(code => ({ host, code }))))(
  "retains a complete V1 checkpoint after host replay cleanup: $host / $code", async ({ host, code }) => {
    const original = { type: "message", role: "user", content: "The synthetic region is eu-west-2." };
    const kept = { type: "message", id: "msg_retained", role: "assistant", content: [{ type: "output_text", text: "Ready." }] };
    const compaction = { type: "compaction", encrypted_content: "opaque-synthetic-window" };
    const tail = { type: "message", role: "user", content: "Which region did I specify?" };
    const sent: Array<{ input: Array<Record<string, unknown>> }> = [];
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body.toString());
      if (req.url?.endsWith("/responses/compact")) {
        writeJsonResponse(res, { object: "response.compaction", output: [kept, compaction] });
        return;
      }
      sent.push(body);
      const index = body.input.findIndex((item: Record<string, unknown>) => item.type === "compaction");
      writeJsonResponse(res, index >= 0 ? { error: { code, param: `input[${index}].encrypted_content` } }
        : { id: "resp_synthetic", status: "completed", output: [] }, index >= 0 ? 400 : 200);
    });
    const app = await startApp(upstream.url.replace("127.0.0.1", host), upstream.url, {
      primary_failover: { auto_schedule: false, state_recovery_retention_hours: 1 }
    });
    const headers = { "x-compactgate-session": "synthetic-host-window" };
    const seed = await postJson(app.url, "/v1/responses/compact", { model: "synthetic", store: false, input: [original, kept] }, headers);
    expect(seed.status).toBe(200);
    await seed.text();
    await waitForLogEntry(app.url, entry => entry.request_id === seed.headers.get("x-compactgate-request-id"));
    const follow = await postJson(app.url, "/v1/responses", { model: "synthetic", store: false, input: [kept, compaction, tail] }, headers);
    await follow.text();
    expect(follow.status).toBe(200);
    expect(sent.at(-1)?.input).toEqual([original, { type: kept.type, role: kept.role, content: kept.content }, tail]);
    expect(follow.headers.get("x-compactgate-context-fidelity")).toBe("exact");
  }
);
