import { expect, it } from "vitest";
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from "node:zlib";
import { runProviderStateMigration } from "../src/server/provider-state-migration.js";
import { isEligibleGenericProviderStateFailure } from "../src/server/provider-state-evidence.js";
import { extractResponseErrorSummary } from "../src/server/usage-error.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";
import { captureRequest, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

function result(status: number, body: unknown, gzip = false): BufferedUpstreamResult {
  const responseBody = gzip ? gzipSync(JSON.stringify(body)) : Buffer.from(JSON.stringify(body));
  const responseHeaders = { "content-type": "application/json", ...(gzip ? { "content-encoding": "gzip" } : {}) };
  return { status, responseBody, responseHeaders, responseBodyTruncated: false,
    errorSummary: extractResponseErrorSummary(status, responseBody, responseHeaders), firstTokenMs: 1,
    streamSummary: null, clientDisconnectPhase: "none" };
}

it.each([false, true])("keeps later null-reasoning coordinates after an earlier item was removed (id=%s)", async withId => {
  const compaction = { type: "compaction", encrypted_content: "valid-opaque-compaction" };
  const tail = { type: "message", role: "user", content: "Continue the synthetic task." };
  const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [
    { type: "reasoning", encrypted_content: "rejected-first", summary: [] }, compaction,
    { type: "reasoning", encrypted_content: null, summary: [], ...(withId ? { id: "rs_second" } : {}) }, tail
  ] }));
  const sent: Array<{ input: Array<Record<string, unknown>> }> = [];
  const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "synthetic", canReplay: () => true,
    startGenericRecovery: () => null,
    send: async body => {
      const parsed = JSON.parse(body.toString());
      sent.push(parsed);
      const index = parsed.input.findIndex((item: Record<string, unknown>) => item.type === "reasoning");
      return index >= 0 ? result(400, { error: { code: "invalid_encrypted_content", param: `input[${index}].encrypted_content` } })
        : result(200, { status: "completed", output: [] });
    }
  });
  expect(recovery.result.status).toBe(200);
  expect(sent).toHaveLength(3);
  expect(sent[2].input).toEqual([compaction, tail]);
});

it.each([401, 429, 400, 502])("stops generic recovery when the second attempt reports an excluded failure (%s)", async status => {
  const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [
    { type: "reasoning", encrypted_content: null, id: "rs_synthetic", summary: [] },
    { type: "message", role: "user", content: "Continue." }
  ] }));
  const failures = [result(502, { error: { message: "Synthetic relay could not process state." } }),
    result(status, { error: { type: "invalid_request_error", code: status === 400 ? "model_not_found" : "invalid_api_key", message: "Synthetic request rejected." } })];
  const sent: string[] = [];
  const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "synthetic", canReplay: () => true,
    startGenericRecovery: failure => isEligibleGenericProviderStateFailure(failure) ? "profile_switch_failure" : null,
    send: async (_body, strategy) => { sent.push(strategy); return failures[Math.min(sent.length - 1, 1)]; }
  });
  expect(sent).toEqual(["original", "cpa"]);
  expect(recovery.result).toBe(failures[1]);
});

it.each([false, true])("excludes a structured unavailable model under compression=%s", gzip => {
  const failure = result(400, { error: { type: "invalid_request_error", code: "model_not_found", message: "Synthetic request rejected." } }, gzip);
  expect(isEligibleGenericProviderStateFailure(failure)).toBe(false);
});

it.each(["br", "deflate", "zstd"])("excludes model error codes when response uses %s", encoding => {
  const body = { error: { type: "invalid_request_error", code: "model_not_found", message: "Synthetic request rejected." } };
  const failure = result(400, body);
  failure.responseBody = ({ br: brotliCompressSync, deflate: deflateSync, zstd: zstdCompressSync })[encoding]!(JSON.stringify(body));
  failure.responseHeaders["content-encoding"] = encoding;
  failure.errorSummary = extractResponseErrorSummary(400, failure.responseBody, failure.responseHeaders);
  expect(isEligibleGenericProviderStateFailure(failure)).toBe(false);
});

it.each([false, true])("HTTP preserves unrelated compaction while repairing shifted null reasoning (id=%s)", async withId => {
  const sent: Array<{ input: Array<Record<string, unknown>> }> = [];
  const upstream = await startUpstream(async (req, res) => {
    const parsed = JSON.parse((await captureRequest(req)).body.toString());
    sent.push(parsed);
    const index = parsed.input.findIndex((item: Record<string, unknown>) => item.type === "reasoning");
    writeJsonResponse(res, index < 0 ? { id: "resp_synthetic", status: "completed", output: [] }
      : { error: { code: "invalid_encrypted_content", param: `input[${index}].encrypted_content` } }, index < 0 ? 200 : 400);
  });
  const app = await startApp(upstream.url, upstream.url, { primary_failover: { auto_schedule: false } });
  const response = await postJson(app.url, "/v1/responses", { model: "synthetic-model", store: false, input: [
    { type: "reasoning", encrypted_content: "rejected-first", summary: [] },
    { type: "compaction", encrypted_content: "valid-opaque-compaction" },
    { type: "reasoning", encrypted_content: null, summary: [], ...(withId ? { id: "rs_second" } : {}) },
    { type: "message", role: "user", content: "Continue." }
  ] }, { "x-compactgate-session": "synthetic-shift", "x-codex-beta-features": "remote_compaction_v2" });
  await response.text();
  expect.soft(response.status).toBe(200);
  expect.soft(sent).toHaveLength(3);
  expect(sent.every(body => body.input.some(item => item.type === "compaction" && item.encrypted_content === "valid-opaque-compaction"))).toBe(true);
  if (sent[2]) {
    expect(sent[2].input).toHaveLength(2);
    expect(sent[2].input[0]).toEqual({ type: "compaction", encrypted_content: "valid-opaque-compaction" });
  }
});

it("HTTP stops generic migration at a later 401 after legitimate two-strike recovery begins", async () => {
  const attempts: string[] = [];
  const upstream = await startUpstream(async (req, res) => {
    const body = JSON.parse((await captureRequest(req)).body.toString());
    if (body.input[0]?.content === "Seed target health.") {
      writeJsonResponse(res, { id: "resp_health", status: "completed", output: [] });
      return;
    }
    const reasoning = body.input.find((item: Record<string, unknown>) => item.type === "reasoning");
    const strategy = reasoning ? Object.hasOwn(reasoning, "encrypted_content") ? "original" : "cpa" : "cross_domain";
    attempts.push(strategy);
    writeJsonResponse(res, strategy === "original" ? { error: { message: "Synthetic relay could not process state." } }
      : { error: { code: "invalid_api_key", message: "Invalid API key." } }, strategy === "original" ? 502 : 401);
  });
  const app = await startApp(upstream.url, upstream.url, { primary_failover: { auto_schedule: false } });
  const seed = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: [{ type: "message", role: "user", content: "Seed target health." }] },
    { "x-compactgate-session": "synthetic-health" });
  expect(seed.status).toBe(200);
  await seed.text();
  await waitForLogEntry(app.url, log => log.status === 200);
  const body = { model: "synthetic-model", store: false, input: [
    { type: "reasoning", encrypted_content: null, id: "rs_synthetic", summary: [] },
    { type: "message", role: "user", content: "Continue." }
  ] };
  const headers = { "x-compactgate-session": "synthetic-unknown-source" };
  const first = await postJson(app.url, "/v1/responses", body, headers);
  expect(first.status).toBe(502);
  await first.text();
  const second = await postJson(app.url, "/v1/responses", body, headers);
  expect(second.status).toBe(401);
  await second.text();
  expect(attempts).toEqual(["original", "original", "cpa"]);
});

it.each(["identity", "br", "deflate"])("HTTP does not start recovery for an unavailable model encoded as %s", async encoding => {
  let statefulAttempts = 0;
  const upstream = await startUpstream(async (req, res) => {
    const body = JSON.parse((await captureRequest(req)).body.toString());
    if (body.input[0]?.content === "Seed target health.") {
      writeJsonResponse(res, { status: "completed", output: [] });
      return;
    }
    statefulAttempts++;
    const error = JSON.stringify({ error: { type: "invalid_request_error", code: "model_not_found", message: "Synthetic request rejected." } });
    const compress = { br: brotliCompressSync, deflate: deflateSync }[encoding];
    res.writeHead(400, { "content-type": "application/json", ...(compress ? { "content-encoding": encoding } : {}) });
    res.end(compress ? compress(error) : error);
  });
  const app = await startApp(upstream.url, upstream.url, { primary_failover: { auto_schedule: false } });
  const seed = await postJson(app.url, "/v1/responses", { model: "synthetic-model", input: [{ type: "message", role: "user", content: "Seed target health." }] },
    { "x-compactgate-session": "synthetic-health" });
  expect(seed.status).toBe(200);
  await seed.text();
  await waitForLogEntry(app.url, log => log.status === 200);
  const body = { model: "synthetic-model", store: false, input: [
    { type: "reasoning", encrypted_content: null, id: "rs_synthetic", summary: [] },
    { type: "message", role: "user", content: "Continue." }
  ] };
  for (let index = 0; index < 2; index++) {
    const response = await postJson(app.url, "/v1/responses", body, { "x-compactgate-session": "synthetic-unavailable-model" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "model_not_found" } });
  }
  expect(statefulAttempts).toBe(2);
});

it("retains the legitimate original-to-CPA-to-strict recovery path", async () => {
  const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [
    { type: "reasoning", encrypted_content: null, id: "rs_synthetic", summary: [] },
    { type: "message", role: "user", content: "Continue." }
  ] }));
  const sent: string[] = [];
  const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "synthetic", canReplay: () => true,
    startGenericRecovery: failure => isEligibleGenericProviderStateFailure(failure) ? "profile_switch_failure" : null,
    send: async (_body, strategy) => {
      sent.push(strategy);
      return strategy === "cross_domain" ? result(200, { status: "completed", output: [] })
        : result(502, { error: { message: "Synthetic relay could not process state." } });
    }
  });
  expect(sent).toEqual(["original", "cpa", "cross_domain"]);
  expect(recovery.result.status).toBe(200);
});
