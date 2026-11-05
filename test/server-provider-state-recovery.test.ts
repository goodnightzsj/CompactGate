import { describe, expect, it } from "vitest";
import { captureRequest, startApp, startAppInDir, startUpstream, JSON_HEADERS, writeJsonResponse } from "./helpers/server-test-utils.js";
import { waitForLogEntry } from "./helpers/server-test-logs.js";

const state = { type: "compaction", id: "cmp_recovery", encrypted_content: "opaque-provider-state" };
const original = { type: "message", role: "user", content: "The deployment region is eu-west-2." };
const next = { type: "message", role: "user", content: "Which region did I specify?" };
const error = { error: { type: "invalid_request_error", code: null, param: "input[0].encrypted_content",
  message: "OpenAI Responses bad request: The encrypted content for item cmp_recovery could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=synthetic]" } };
const headers = { ...JSON_HEADERS, "x-compactgate-session": "recovery-session", "x-codex-beta-features": "remote_compaction_v2" };
const post = (url: string, input: unknown[], extra: Record<string, unknown> = {}) => fetch(`${url}/v1/responses`, {
  method: "POST", headers, body: JSON.stringify({ model: "gpt-synthetic", store: false, input, ...extra })
});

describe("persistent state recovery HTTP boundary", () => {
  it("never blocks retries of unavailable state across credential, project, session or mode changes", async () => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureRequest(req); attempts++;
      writeJsonResponse(res, error, 400);
    });
    const app = await startApp(upstream.url, upstream.url);
    const send = (extra: Record<string, string> = {}) => fetch(`${app.url}/v1/responses`, { method: "POST", headers: { ...headers, ...extra },
      body: JSON.stringify({ model: "gpt-synthetic", input: [state, next] }) });
    expect((await send()).status).toBe(400);
    await waitForLogEntry(app.url, log => log.provider_state_portability?.recovery_unavailable === true);
    expect((await send()).status).toBe(400);
    expect((await send({ "openai-project": "synthetic-other-project" })).status).toBe(400);
    expect((await send({ "x-compactgate-session": "another-session" })).status).toBe(400);
    const patch = async (body: unknown) => {
      const response = await fetch(`${app.url}/api/config`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
    };
    await patch({ primary: { api_key: "synthetic-other-credential" } });
    expect((await send()).status).toBe(400);
    await patch({ primary_failover: { state_portability: "off" } });
    expect((await send()).status).toBe(400);
    expect(attempts).toBe(6);
  });

  it("restores a missing continuation from a complete prior response", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recorded eu-west-2." }] };
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body) as Record<string, unknown>;
      requests.push(body);
      if (body.previous_response_id) writeJsonResponse(res, { error: { code: "previous_response_not_found" } }, 400);
      else writeJsonResponse(res, { id: "resp_checkpoint", status: "completed", output: [answer] });
    });
    const app = await startApp(upstream.url, upstream.url, { primary_failover: { state_recovery_retention_hours: 1 } });
    await (await post(app.url, [original])).text();
    await waitForLogEntry(app.url, log => log.status === 200);
    const recovered = await post(app.url, [next], { previous_response_id: "resp_checkpoint" });
    expect(recovered.status).toBe(200);
    await recovered.text();
    expect(requests[2]).not.toHaveProperty("previous_response_id");
    expect(requests[2].input).toEqual([original, answer, next]);
  });

  it("does not replay a committed SSE error or remember it as complete output", async () => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureRequest(req); attempts++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.created","response":{"id":"resp_partial"}}\n\n');
      res.write('data: {"type":"response.output_text.delta","delta":"Already delivered."}\n\n');
      res.end(`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: error.error } })}\n\n`);
    });
    const app = await startApp(upstream.url, upstream.url, { primary_failover: { state_recovery_retention_hours: 1 } });
    const response = await post(app.url, [state, next], { stream: true });
    expect(await response.text()).toContain("response.failed");
    expect(attempts).toBe(1);
    expect(response.headers.get("x-compactgate-state-recovery")).toBeNull();
  });

  it("purges opted-in checkpoints when the configuration API disables retention", async () => {
    const requests: Array<{ input: Array<{ type: string }> }> = [];
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body) as { input: Array<{ type: string }> };
      requests.push(body);
      if (body.input.some(item => item.type === "compaction")) writeJsonResponse(res, error, 400);
      else writeJsonResponse(res, { id: "resp_seed", status: "completed", output: [state] });
    });
    const app = await startApp(upstream.url, upstream.url, { primary_failover: { state_recovery_retention_hours: 1 } });
    await (await post(app.url, [original])).text();
    await waitForLogEntry(app.url, log => log.status === 200);
    const patch = await fetch(`${app.url}/api/config`, { method: "PATCH", headers: JSON_HEADERS,
      body: JSON.stringify({ primary_failover: { state_recovery_retention_hours: 0 } }) });
    expect(patch.status).toBe(200);
    const followup = await post(app.url, [state, next]);
    expect(followup.status).toBe(200);
    expect(followup.headers.get("x-compactgate-context-fidelity")).toBe("degraded");
    await followup.text();
    expect(requests.at(-1)?.input).toEqual([next]);
  });

  it("retries original context after unsuccessful lossy recovery and restart", async () => {
    let attempts = 0;
    let acceptsState = false;
    const requests: Array<{ input: unknown[] }> = [];
    const upstream = await startUpstream(async (req, res) => {
      requests.push(JSON.parse((await captureRequest(req)).body)); attempts++;
      writeJsonResponse(res, acceptsState ? { status: "completed", output: [] } : error, acceptsState ? 200 : 400);
    });
    const app = await startApp(upstream.url, upstream.url);
    const first = await post(app.url, [state, next]);
    expect(first.status).toBe(400);
    expect(await first.json()).toEqual(error);
    await waitForLogEntry(app.url, log => log.provider_state_portability?.attempts.some(attempt => attempt.migration_counts.compactionItemsRemoved === 1) === true);
    expect(requests.at(-1)?.input).toEqual([next]);
    await app.close();
    acceptsState = true;
    const restarted = await startAppInDir(app.dir, upstream.url, upstream.url);
    const second = await post(restarted.url, [state, { ...next, content: "Retry, without discarding my history." }]);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "completed" });
    expect(attempts).toBe(4);
    expect(requests.at(-1)?.input[0]).toEqual(state);
  });

  it.each(["json", "sse"])("restores opt-in %s checkpoints and reuses the successful repair across restart", async transport => {
    const requests: Array<Record<string, unknown>> = [];
    let rejected = 0;
    const upstream = await startUpstream(async (req, res) => {
      const request = JSON.parse((await captureRequest(req)).body) as Record<string, unknown>;
      requests.push(request);
      const input = request.input as Array<Record<string, unknown>>;
      if (input.some(item => item.type === "compaction")) { rejected++; writeJsonResponse(res, error, 400); return; }
      const output = requests.length === 1 ? [state] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "eu-west-2" }] }];
      const response = { id: `resp_${requests.length}`, status: "completed", output };
      if (transport === "json") writeJsonResponse(res, response);
      else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        output.forEach((item, index) => res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`));
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
      }
    });
    const app = await startApp(upstream.url, upstream.url, { primary_failover: { auto_schedule: false, state_recovery_retention_hours: 1 } });
    const stream = transport === "sse";
    const seed = await post(app.url, [original], { stream });
    expect(seed.status).toBe(200);
    await seed.text();
    await waitForLogEntry(app.url, log => log.status === 200);
    const recovered = await post(app.url, [state, next], { stream });
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-compactgate-context-fidelity")).toBe("exact");
    expect(await recovered.text()).toContain("eu-west-2");
    await waitForLogEntry(app.url, log => log.provider_state_portability?.trigger === "explicit_400");
    expect(requests[3].input).toEqual([original, next]);
    await app.close();
    const restarted = await startAppInDir(app.dir, upstream.url, upstream.url);
    const reused = await post(restarted.url, [state, next], { stream });
    expect(reused.status).toBe(200);
    expect(reused.headers.get("x-compactgate-state-recovery")).toBe("cached");
    await reused.text();
    expect(rejected).toBe(2);
    expect(requests[4].input).toEqual([original, next]);
  });

  it("restores the entire V1 compact window instead of treating retained output as a summary", async () => {
    const requests: Array<{ path: string | undefined; body: Record<string, unknown> }> = [];
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body) as Record<string, unknown>;
      requests.push({ path: req.url, body });
      writeJsonResponse(res, req.url?.endsWith("/compact")
        ? { object: "response.compaction", id: "compact_fixture", output: [original, state] }
        : { id: "resp_ok", status: "completed", output: [] });
    });
    const app = await startApp(upstream.url, upstream.url, { primary_failover: { state_recovery_retention_hours: 1 } });
    const tool = [
      { type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "eu-west-2" }
    ];
    const compact = await fetch(`${app.url}/v1/responses/compact`, { method: "POST", headers,
      body: JSON.stringify({ model: "gpt-synthetic", input: [original, ...tool] }) });
    expect(compact.status).toBe(200);
    await compact.text();
    await waitForLogEntry(app.url, log => log.route === "compact");
    const followup = await fetch(`${app.url}/v1/responses`, { method: "POST", headers: { ...JSON_HEADERS, "x-compactgate-session": "recovery-session" },
      body: JSON.stringify({ model: "gpt-synthetic", input: [original, state, next] }) });
    expect(followup.status).toBe(200);
    await followup.text();
    expect(requests[1].body.input).toEqual([original, ...tool, next]);
  });

  it.each(["json", "sse"])("checkpoints a deduplicated V1 %s result after retention is enabled", async transport => {
    let compactCalls = 0;
    const primaryInputs: unknown[] = [];
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body) as { input: unknown };
      if (req.url?.endsWith("/compact")) {
        compactCalls++;
        const response = { object: "response.compaction", output: [original, state] };
        if (transport === "json") writeJsonResponse(res, response);
        else { res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`); }
      } else {
        primaryInputs.push(body.input);
        const index = Array.isArray(body.input) ? body.input.findIndex(item => item.type === "compaction") : -1;
        if (index >= 0) writeJsonResponse(res, { error: { ...error.error, param: `input[${index}].encrypted_content` } }, 400);
        else writeJsonResponse(res, { output: [] });
      }
    });
    const app = await startApp(upstream.url, upstream.url);
    const compact = () => fetch(`${app.url}/v1/responses/compact`, { method: "POST", headers,
      body: JSON.stringify({ model: "gpt-synthetic", input: [original], stream: transport === "sse" }) });
    await (await compact()).text();
    await waitForLogEntry(app.url, log => log.route === "compact");
    const patch = await fetch(`${app.url}/api/config`, { method: "PATCH", headers: JSON_HEADERS,
      body: JSON.stringify({ primary_failover: { state_recovery_retention_hours: 1 } }) });
    expect(patch.status).toBe(200);
    await (await compact()).text();
    expect(compactCalls).toBe(1);
    const followup = await fetch(`${app.url}/v1/responses`, { method: "POST", headers: { ...JSON_HEADERS, "x-compactgate-session": "recovery-session" },
      body: JSON.stringify({ model: "gpt-synthetic", input: [original, state, next] }) });
    expect(followup.status).toBe(200);
    await followup.text();
    expect(primaryInputs.at(-1)).toEqual([original, next]);
  });
});
