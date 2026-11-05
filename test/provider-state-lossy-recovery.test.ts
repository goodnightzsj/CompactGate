import { describe, expect, it } from "vitest";
import { classifyProviderStateFailure } from "../src/server/provider-state-errors.js";
import { runProviderStateMigration } from "../src/server/provider-state-migration.js";
import { compileProviderStateAttempt } from "../src/server/provider-state-portability.js";
import { encryptedAgentMessage, encryptedAgentError } from "./helpers/encrypted-agent-message.js";
import { captureRequest, startApp, startUpstream, JSON_HEADERS, writeJsonResponse } from "./helpers/server-test-utils.js";
import { waitForLogEntry } from "./helpers/server-test-logs.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";

const compaction = { type: "compaction", id: "cmp_drop", encrypted_content: "gAAA_synthetic_1pU=" };
const reasoning = { type: "reasoning", encrypted_content: "opaque-reasoning", summary: [] };
const message = { type: "message", role: "user", content: "Continue with the visible context." };
const tail = [message, message,
  { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
  { type: "function_call_output", call_id: "call_a", output: "visible result" },
  { type: "custom_tool_call", call_id: "call_b", name: "lookup", input: "query" },
  { type: "custom_tool_call_output", call_id: "call_b", output: "visible result" }];
const error = (target = "gAAA...1pU=") => ({ error: { type: "invalid_request_error", code: null, param: "",
  message: `OpenAI Responses bad request: The encrypted content ${target} could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=synthetic]` } });
const encode = (body: unknown) => Buffer.from(JSON.stringify(body));
const failure = classifyProviderStateFailure(400, encode(error()))!;
const targetedFailure = classifyProviderStateFailure(400, encode(error("for item cmp_drop")))!;
const result = (status: number, body: unknown): BufferedUpstreamResult => ({ status, responseBody: encode(body),
  responseHeaders: { "content-type": "application/json" }, errorSummary: status >= 400 ? `HTTP ${status}` : null,
  responseBodyTruncated: false, firstTokenMs: 1, streamSummary: null, clientDisconnectPhase: "none" });

describe("explicitly rejected compaction lossy continuation", () => {
  it("drops only the targeted opaque item and preserves all other input and canonical bytes", () => {
    const other = { ...compaction, id: "cmp_other", encrypted_content: "other-opaque-state" };
    const body = { store: false, input: [compaction, reasoning, other, encryptedAgentMessage, ...tail] };
    const canonical = encode(body);
    const recovered = compileProviderStateAttempt(canonical, { strategy: "error_400", errorCode: "invalid_encrypted_content",
      failure: targetedFailure, allowCompactionDrop: true });
    expect(JSON.parse(recovered.body.toString())).toEqual({ ...body, input: body.input.slice(1) });
    expect(recovered.fidelity).toBe("degraded");
    expect(recovered.metrics).toMatchObject({ compactionItemsRemoved: 1, compactionItemsReplaced: 0, orphanToolItemsRemoved: 0 });
    expect(canonical).toEqual(encode(body));
  });

  it.each(["missing-store", "stored", "continuation", "continuation-alias", "reference", "untyped-reference", "only-compaction", "ambiguous", "no-live-error", "other-error", "strict"])(
    "does not discard context for %s", guard => {
      const body: Record<string, unknown> = { store: false, input: [compaction, ...tail] };
      if (guard === "missing-store") delete body.store;
      if (guard === "stored") body.store = true;
      if (guard === "continuation") body.previous_response_id = "resp_old";
      if (guard === "continuation-alias") body.previousResponseId = "resp_old";
      if (guard === "reference") body.input = [compaction, { type: "item_reference", id: "remote" }, ...tail];
      if (guard === "untyped-reference") body.input = [compaction, { id: "remote" }, ...tail];
      if (guard === "only-compaction") body.input = [compaction];
      if (guard === "ambiguous") body.input = [compaction, { ...compaction, id: "cmp_other" }, ...tail];
      const canonical = encode(body);
      expect(() => compileProviderStateAttempt(canonical, { strategy: "error_400", failure,
        errorCode: guard === "other-error" ? "invalid_responses_request" : "invalid_encrypted_content",
        priorStrategy: guard === "strict" ? "cross_domain" : "original", allowCompactionDrop: guard !== "no-live-error"
      })).toThrow("no complete recovery checkpoint");
      expect(canonical).toEqual(encode(body));
    }
  );

  it.each(["summary", "checkpoint"])("prefers available %s over loss", source => {
    const summary = "All prior work is recorded in this readable summary.";
    const body = encode({ store: false, input: [{ ...compaction, encrypted_content: source === "summary" ? summary : compaction.encrypted_content }, ...tail] });
    const recovered = compileProviderStateAttempt(body, { strategy: "error_400", errorCode: "invalid_encrypted_content",
      failure, allowCompactionDrop: true, recoverCompaction: source === "checkpoint"
        ? () => ({ body: encode({ store: false, input: [message, ...tail] }), fidelity: "exact" }) : undefined });
    expect(recovered.fidelity).toBe(source === "summary" ? "summary" : "exact");
    expect(recovered.metrics).toMatchObject({ compactionItemsRemoved: 0, compactionItemsReplaced: 1 });
    expect((JSON.parse(recovered.body.toString()) as { input: unknown[] }).input).toHaveLength(tail.length + 1);
  });

  it("keeps a prior targeted compaction removal through later reasoning and agent failures", async () => {
    const canonical = { store: false, input: [{ ...compaction, id: undefined }, reasoning, encryptedAgentMessage, ...tail] };
    const failures = [{ error: { code: "invalid_encrypted_content", param: "input[0].encrypted_content" } },
      { error: { code: "invalid_encrypted_content", param: "input[0].encrypted_content" } }, encryptedAgentError];
    const sent: unknown[] = [];
    const recovered = await runProviderStateMigration({ canonicalBody: encode(canonical), targetStateDomain: "synthetic",
      canReplay: () => true, startGenericRecovery: () => null,
      send: async body => { sent.push(JSON.parse(body.toString())); return sent.length <= failures.length
        ? result(400, failures[sent.length - 1]) : result(200, { status: "completed", output: [] }); }
    });
    expect(recovered.result.status).toBe(200);
    expect(sent).toHaveLength(4);
    expect(sent[3]).toEqual({ store: false, input: [
      { ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]] }, ...tail] });
    expect(recovered.attempts[3].compiled.metrics.compactionItemsRemoved).toBe(1);
  });

  it.each([200, 400, 503])("reaches the fourth lossy attempt and preserves its actual HTTP %s result", async status => {
    const canonical = encode({ store: false, input: [compaction, reasoning, encryptedAgentMessage, ...tail] });
    const sent: Buffer[] = [];
    const last = result(status, status === 200 ? { status: "completed", output: [] }
      : status === 400 ? error() : { error: { code: "unavailable" } });
    const recovered = await runProviderStateMigration({ canonicalBody: canonical, targetStateDomain: "synthetic",
      canReplay: () => true, startGenericRecovery: () => { throw new Error("No generic recovery expected"); },
      send: async body => { sent.push(body); return sent.length === 1 ? result(400, error("for item cmp_drop"))
        : sent.length < 4 ? result(400, error()) : last; }
    });
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual(canonical);
    expect(recovered.result).toBe(last);
    expect(recovered.attempts[3].compiled).toMatchObject({ fidelity: "degraded", metrics: { compactionItemsRemoved: 1,
      encryptedReasoningFieldsRemoved: 1, encryptedAgentMessageBlocksRemoved: 1, orphanToolItemsRemoved: 0 } });
    expect(JSON.parse(sent[3].toString()).input).toEqual([
      { ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]] }, ...tail]);
    if (status !== 200) return;
    const cachedSent: Buffer[] = [];
    const cached = await runProviderStateMigration({ canonicalBody: canonical, targetStateDomain: "synthetic", cachedPolicy: recovered.policy,
      canReplay: () => true, startGenericRecovery: () => null,
      send: async body => { cachedSent.push(body); return last; }
    });
    expect(cached.result.status).toBe(200);
    expect(cachedSent).toEqual([canonical]);
  });

  it.each(["cancelled", "truncated"])("does not enter lossy retry after %s ID-only attempt", async guard => {
    const sent: Buffer[] = [];
    const recovered = await runProviderStateMigration({ canonicalBody: encode({ store: false, input: [compaction, ...tail] }),
      targetStateDomain: "synthetic", canReplay: () => guard !== "cancelled" || sent.length < 2, startGenericRecovery: () => null,
      send: async body => { sent.push(body); return { ...result(400, error()), responseBodyTruncated: guard === "truncated" && sent.length === 2 }; }
    });
    expect(sent).toHaveLength(2);
    expect(recovered.result.status).toBe(400);
    expect(JSON.parse(sent[1].toString()).input[0]).toEqual({ type: "compaction", encrypted_content: compaction.encrypted_content });
    expect(recovered.attempts.every(attempt => attempt.compiled.metrics.compactionItemsRemoved === 0)).toBe(true);
  });

  it.each(["json", "sse"])("continues through a real HTTP %s boundary without history retention", async transport => {
    const requests: Array<Record<string, unknown>> = [];
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body) as Record<string, unknown>;
      requests.push(body);
      const items = body.input as Array<Record<string, unknown>>;
      if (items.some(item => item.type === "compaction" && typeof item.id === "string")) {
        writeJsonResponse(res, error("for item cmp_drop"), 400); return;
      }
      if (items.some(item => item.type === "compaction")) { writeJsonResponse(res, error(), 400); return; }
      const response = { id: "resp_synthetic", status: "completed", output: [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: "Continued using the visible context." }] }] };
      if (transport === "json") writeJsonResponse(res, response);
      else { res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`); }
    });
    const app = await startApp(upstream.url, upstream.url, { primary_failover: { state_recovery_retention_hours: 0 } });
    const response = await fetch(`${app.url}/v1/responses`, { method: "POST", headers: { ...JSON_HEADERS,
      "x-codex-beta-features": "remote_compaction_v2", "x-compactgate-session": "lossy-synthetic" },
    body: JSON.stringify({ model: "gpt-synthetic", store: false, stream: transport === "sse", input: [compaction, reasoning, encryptedAgentMessage, ...tail] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-context-fidelity")).toBe("degraded");
    expect(response.headers.get("x-compactgate-state-recovery")).toBe("recovered");
    expect(await response.text()).toContain("Continued using the visible context.");
    expect(requests).toHaveLength(4);
    expect(requests[3].input).toEqual([
      { ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]] }, ...tail]);
    const log = await waitForLogEntry(app.url, entry => entry.status === 200 && entry.provider_state_portability?.trigger === "explicit_400");
    expect(log.provider_state_portability?.attempts[3]).toMatchObject({ fidelity: "degraded", migration_counts: { compactionItemsRemoved: 1 } });
  });
});
