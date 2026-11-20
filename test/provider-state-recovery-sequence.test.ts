import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runProviderStateMigration } from "../src/server/provider-state-migration.js";
import { ProviderStateRecoveryStore } from "../src/server/provider-state-recovery-store.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";
import { captureRequest, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

it.each(["invalid_responses_request", "invalid_encrypted_content"])(
  "does not expand compaction loss authorization when a %s checkpoint expires mid-request", async code => {
    const history = { type: "message", role: "user", content: "Synthetic history" };
    const reasoning = { type: "reasoning", encrypted_content: "rejected-reasoning", summary: [] };
    const tail = { type: "message", role: "user", content: "Continue" };
    const sent: unknown[] = [];
    const result = await runProviderStateMigration({
      canonicalBody: Buffer.from(JSON.stringify({ store: false, input: [
        { type: "compaction", encrypted_content: "synthetic-opaque-state" }, reasoning, tail
      ] })), targetStateDomain: "synthetic", canReplay: () => true, startGenericRecovery: () => null,
      recoverCompaction: () => sent.length === 1 ? {
        body: Buffer.from(JSON.stringify({ store: false, input: [history, reasoning, tail] })), fidelity: "exact"
      } : null,
      send: async body => {
        sent.push(JSON.parse(body.toString()));
        const error = sent.length === 1 ? { code, param: "input[0]" }
          : { code: "invalid_encrypted_content", param: "input[1]" };
        return { status: sent.length < 3 ? 400 : 200, responseBody: Buffer.from(JSON.stringify(sent.length < 3 ? { error } : { output: [] })),
          responseHeaders: {}, responseBodyTruncated: false, errorSummary: null, firstTokenMs: null,
          streamSummary: null, clientDisconnectPhase: "none" };
      }
    });
    if (code === "invalid_responses_request") {
      expect(result.result.status).toBe(400);
      expect(sent).toHaveLength(2);
      expect(JSON.parse(result.result.responseBody.toString()).error.code).toBe("invalid_encrypted_content");
    } else {
      expect(result.result.status).toBe(200);
      expect(sent.at(-1)).toMatchObject({ input: [tail] });
    }
  }
);

it.each(["previous_response_not_found", "invalid_responses_request", "invalid_encrypted_content"])(
  "persists cumulative checkpoint recovery after %s and falls back when material expires", async code => {
    const db = new DatabaseSync(":memory:");
    try {
      const store = new ProviderStateRecoveryStore(db);
      const history = { type: "message", role: "user", content: "Retain synthetic history." };
      const reasoning = { type: "reasoning", encrypted_content: "rejected-reasoning", summary: [] };
      const canonicalBody = Buffer.from(JSON.stringify({ store: false,
        ...(code === "previous_response_not_found" ? { previous_response_id: "resp_old" } : {}),
        input: [...(code === "previous_response_not_found" ? [] : [{ type: "compaction", encrypted_content: "synthetic-state" }]), reasoning]
      }));
      const response = (status: number, body: unknown): BufferedUpstreamResult => ({ status,
        responseBody: Buffer.from(JSON.stringify(body)), responseHeaders: { "content-type": "application/json" },
        responseBodyTruncated: false, errorSummary: null, firstTokenMs: null, streamSummary: null, clientDisconnectPhase: "none" });
      const options = { canonicalBody, targetStateDomain: "synthetic", canReplay: () => true,
        startGenericRecovery: () => null, recoverCompaction: () => ({
          body: Buffer.from(JSON.stringify({ store: false, input: [history, reasoning] })), fidelity: "exact" as const
        }) };
      let attempt = 0;
      const recovered = await runProviderStateMigration({ ...options, send: async body => {
        attempt++;
        if (attempt === 1) return response(400, { error: { code, ...(code === "invalid_encrypted_content" ? { param: "input[0]" } : {}) } });
        if (attempt === 2) return response(400, { error: { code: "invalid_encrypted_content", param: "input[1]" } });
        expect(JSON.parse(body.toString()).input).toEqual([history]);
        return response(200, { output: [] });
      } });
      expect(recovered.result.status).toBe(200);
      expect(attempt).toBe(3);
      expect(store.rememberPolicy("synthetic", recovered.policy!, 1)).toBe(true);
      const cachedPolicy = store.findPolicy("synthetic");
      expect(cachedPolicy?.checkpointRecovery).toBe(code === "previous_response_not_found" ? "continuation"
        : code === "invalid_responses_request" ? "compaction" : undefined);
      const cached = await runProviderStateMigration({ ...options, cachedPolicy, send: async body => {
        expect(JSON.parse(body.toString()).input).toEqual([history]);
        return response(200, { output: [] });
      } });
      expect(cached.attempts).toHaveLength(1);
      const expired = await runProviderStateMigration({ ...options, cachedPolicy, recoverCompaction: () => null,
        send: async body => { expect(body).toEqual(canonicalBody); return response(200, { output: [] }); } });
      expect(expired.attempts).toHaveLength(1);
      expect(expired.trigger).toBeNull();
    } finally { db.close(); }
  }
);

it.each([false, true])("retains earlier repairs across two ciphertext failures (continuation=%s)", async continuation => {
  const sent: Array<{ input: Array<Record<string, unknown>>; previous_response_id?: string }> = [];
  const original = { type: "message", role: "user", content: "The synthetic deployment region is eu-west-2." };
  const answer = { type: "message", role: "assistant", content: "Recorded eu-west-2." };
  const tail = { type: "message", role: "user", content: "Continue the synthetic task." };
  const upstream = await startUpstream(async (req, res) => {
    const body = JSON.parse((await captureRequest(req)).body.toString());
    sent.push(body);
    if (body.previous_response_id) {
      writeJsonResponse(res, { error: { code: "previous_response_not_found" } }, 400);
      return;
    }
    const index = body.input.findIndex((item: Record<string, unknown>) => item.type === "reasoning");
    writeJsonResponse(res, index < 0 ? { id: "resp_checkpoint", status: "completed", output: [answer] }
      : { error: { code: "invalid_encrypted_content", param: `input[${index}].encrypted_content` } }, index < 0 ? 200 : 400);
  });
  const app = await startApp(upstream.url, upstream.url, {
    primary_failover: { auto_schedule: false, state_recovery_retention_hours: 1 }
  });
  const headers = { "x-compactgate-session": "synthetic-r6-continuation", "x-codex-beta-features": "remote_compaction_v2" };
  if (continuation) {
    const seed = await postJson(app.url, "/v1/responses", { model: "synthetic", store: false, input: [original] }, headers);
    expect(seed.status).toBe(200);
    await seed.text();
    await waitForLogEntry(app.url, log => log.request_id === seed.headers.get("x-compactgate-request-id"));
    sent.length = 0;
  }
  const response = await postJson(app.url, "/v1/responses", { model: "synthetic", store: false,
    ...(continuation ? { previous_response_id: "resp_checkpoint" } : {}), input: [
      { type: "reasoning", encrypted_content: "synthetic-rejected-first", summary: [] },
      { type: "reasoning", encrypted_content: "synthetic-rejected-second", summary: [] }, tail
    ]
  }, headers);
  const responseBody = await response.text();
  expect.soft(response.status, JSON.stringify({ responseBody, sent })).toBe(200);
  expect.soft(sent).toHaveLength(continuation ? 4 : 3);
  expect.soft(sent.at(-1)?.input).toEqual(continuation ? [original, answer, tail] : [tail]);
  if (continuation) expect.soft(sent.slice(1).some(body => body.previous_response_id !== undefined)).toBe(false);
});

it.each([false, true])("retains an available compaction checkpoint after a later error (reasoning=%s)", async rejectedReasoning => {
  const original = { type: "message", role: "user", content: "The synthetic deployment region is eu-west-2." };
  const compaction = { type: "compaction", encrypted_content: "synthetic-opaque-state" };
  const tail = { type: "message", role: "user", content: "Which deployment region did I specify?" };
  const sent: Array<{ input: Array<Record<string, unknown>> }> = [];
  const upstream = await startUpstream(async (req, res) => {
    const body = JSON.parse((await captureRequest(req)).body.toString());
    sent.push(body);
    if (body.input.length === 1 && body.input[0].content === original.content) {
      writeJsonResponse(res, { id: "resp_seed", status: "completed", output: [compaction] });
      return;
    }
    const index = body.input.findIndex((item: Record<string, unknown>) => item.type === "compaction" || item.type === "reasoning");
    writeJsonResponse(res, index < 0 ? { id: "resp_follow", status: "completed", output: [] }
      : { error: { code: "invalid_encrypted_content", param: `input[${index}].encrypted_content` } }, index < 0 ? 200 : 400);
  });
  const app = await startApp(upstream.url, upstream.url, {
    primary_failover: { auto_schedule: false, state_recovery_retention_hours: 1 }
  });
  const headers = { "x-compactgate-session": "synthetic-r6-compaction", "x-codex-beta-features": "remote_compaction_v2" };
  const seed = await postJson(app.url, "/v1/responses", { model: "synthetic", store: false, input: [original] }, headers);
  expect(seed.status).toBe(200);
  await seed.text();
  await waitForLogEntry(app.url, log => log.request_id === seed.headers.get("x-compactgate-request-id"));
  sent.length = 0;
  const response = await postJson(app.url, "/v1/responses", { model: "synthetic", store: false, input: [compaction,
    ...(rejectedReasoning ? [{ type: "reasoning", encrypted_content: "synthetic-rejected", summary: [] }] : []), tail
  ] }, headers);
  await response.text();
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(rejectedReasoning ? 3 : 2);
  expect(sent.at(-1)?.input, JSON.stringify(sent)).toEqual([original, tail]);
});
