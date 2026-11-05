import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  runProviderStateMigration
} from "../src/server/provider-state-migration.js";
import { hashProviderStateBody } from "../src/server/provider-state-portability.js";
import type { ProviderStateRecoveryPolicy } from "../src/server/provider-state-recovery-store.js";
import {
  isEligibleGenericProviderStateFailure,
  providerStateLegacyFailureKey,
  providerStateTargetHealthKey
} from "../src/server/provider-state-evidence.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";
import { agentrouterResourceErrorCases } from "./helpers/agentrouter-resource-errors.js";
import { encryptedAgentError, encryptedAgentMessage } from "./helpers/encrypted-agent-message.js";

function validEncryptedContent(): string {
  const payload = Buffer.alloc(73);
  payload[0] = 0x80;
  return payload.toString("base64url");
}

function upstreamResult(status: number, body: unknown): BufferedUpstreamResult {
  return {
    status,
    errorSummary: status >= 400 ? `HTTP ${status}` : null,
    responseBody: Buffer.from(JSON.stringify(body)),
    responseBodyTruncated: false,
    responseHeaders: { "content-type": "application/json" },
    firstTokenMs: 1,
    streamSummary: null,
    clientDisconnectPhase: "none"
  };
}

function canonicalStatefulBody(): Buffer {
  return Buffer.from(JSON.stringify({
    model: "gpt-5.5",
    store: false,
    input: [
      {
        type: "reasoning",
        id: "rs_valid",
        encrypted_content: validEncryptedContent(),
        content: null,
        summary: [{ type: "summary_text", text: "Readable reasoning retained until strict recovery." }]
      },
      {
        type: "reasoning",
        id: "rs_invalid",
        encrypted_content: null,
        content: null,
        summary: []
      }
    ]
  }));
}

function canonicalCompactionBody(): Buffer {
  return Buffer.from(JSON.stringify({
    model: "gpt-5.5",
    input: [
      { type: "compaction", encrypted_content: "The previous work is preserved in this readable summary." },
      { type: "message", role: "user", content: "continue" }
    ]
  }));
}

describe("provider-state recovery state machine", () => {
  it.each([false, true])("retries the original request when a cached repair has no history (unavailable=%s)", async unavailable => {
    const canonicalBody = Buffer.from(JSON.stringify({ input: [{ type: "compaction", encrypted_content: "opaque-state" }] }));
    const cachedPolicy: ProviderStateRecoveryPolicy = { base: "original", stripCompactionIds: false, rejectedCompaction: true,
      priorEncryptedFailures: [], unavailable, failure: { kind: "encrypted_content", code: "invalid_encrypted_content",
        evidence: "code", itemId: null, inputIndex: null, encryptedContentHash: null } };
    const sent: Buffer[] = [];
    const recovery = await runProviderStateMigration({ canonicalBody, cachedPolicy, targetStateDomain: "same",
      canReplay: () => true, startGenericRecovery: () => null,
      send: async body => { sent.push(body); return upstreamResult(200, { output: [] }); }
    });
    expect(sent).toEqual([canonicalBody]);
    expect(recovery.trigger).toBeNull();
    expect(recovery.result.status).toBe(200);
  });

  it.each(["item", "index", "cipher", "abbreviated"])("tries only compaction IDs before restoring rejected %s state", async locator => {
    const compaction = { type: "compaction", id: "cmp_a", encrypted_content: "gAAA_synthetic_8A==" };
    const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [compaction,
      { type: "message", role: "user", content: "Preserve this new instruction." }] }));
    const failure = { error: { type: "invalid_request_error", code: locator === "index" ? "invalid_encrypted_content" : null,
      param: locator === "index" ? "input[0].encrypted_content" : "",
      message: locator === "index" ? "Invalid input." : `OpenAI Responses bad request: The encrypted content ${
        locator === "item" ? "for item cmp_a" : locator === "cipher" ? compaction.encrypted_content : "gAAA...8A=="
      } could not be verified. Reason: Encrypted content could not be decrypted or parsed. [trace_id=synthetic]` } };
    const sent: Buffer[] = [];
    const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "same",
      canReplay: () => true, startGenericRecovery: () => { throw new Error("No generic recovery expected"); },
      send: async body => { sent.push(body); return sent.length === 1 ? upstreamResult(400, failure) : upstreamResult(200, { output: [] }); }
    });
    expect(sent).toHaveLength(2);
    const expected = JSON.parse(canonicalBody.toString());
    delete expected.input[0].id;
    expect(JSON.parse(sent[1].toString())).toEqual(expected);
    expect(recovery.attempts[1].compiled.fidelity).toBe("exact");
    expect(recovery.policy?.stripCompactionIds).toBe(true);
  });

  it("keeps earlier targeted repairs when a later failure identifies the compaction ID", async () => {
    const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [
      { type: "reasoning", encrypted_content: "opaque-reasoning", summary: [] },
      { type: "compaction", id: "cmp_a", encrypted_content: "opaque-compaction" }, encryptedAgentMessage
    ] }));
    const failures = [
      { error: { code: "invalid_encrypted_content", param: "input[0].encrypted_content" } },
      { error: { type: "invalid_request_error", message: "The encrypted content for item cmp_a could not be verified." } },
      encryptedAgentError
    ];
    const sent: Array<{ input: Array<Record<string, unknown>> }> = [];
    const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "same",
      canReplay: () => true, startGenericRecovery: () => null,
      send: async body => { sent.push(JSON.parse(body.toString())); return sent.length <= failures.length
        ? upstreamResult(400, failures[sent.length - 1]) : upstreamResult(200, { output: [] }); }
    });
    expect(sent).toHaveLength(4);
    expect(sent[3].input).toEqual([
      { type: "compaction", encrypted_content: "opaque-compaction" }, { ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]] }]);
    expect(recovery.result.status).toBe(200);
  });

  it("tries the ID after an unlocated error first cleans the other encrypted carriers", async () => {
    const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [
      { type: "reasoning", encrypted_content: "opaque-reasoning", summary: [] },
      { type: "compaction", id: "cmp_a", encrypted_content: "opaque-compaction" }, encryptedAgentMessage
    ] }));
    const sent: Array<{ input: Array<Record<string, unknown>> }> = [];
    const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "same",
      canReplay: () => true, startGenericRecovery: () => null,
      send: async body => { sent.push(JSON.parse(body.toString())); return sent.length < 3
        ? upstreamResult(400, { error: { type: "invalid_request_error", code: null,
          message: "The encrypted content gAAA...8A== could not be verified." } }) : upstreamResult(200, { output: [] }); }
    });
    expect(sent).toHaveLength(3);
    expect(sent[1].input.find(item => item.type === "compaction")?.id).toBe("cmp_a");
    expect(sent[2].input).toEqual([
      { type: "compaction", encrypted_content: "opaque-compaction" }, { ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]] }]);
    expect(recovery.result.status).toBe(200);
  });

  it("preserves the last real rejection when ID removal cannot fix the opaque state", async () => {
    const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [
      { type: "compaction", id: "cmp_a", encrypted_content: "opaque-compaction" }
    ] }));
    const failure = upstreamResult(400, { error: { type: "invalid_request_error", code: null,
      message: "The encrypted content gAAA...8A== could not be verified. [trace_id=synthetic]" } });
    const sent: Buffer[] = [];
    const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "same",
      canReplay: () => true, startGenericRecovery: () => null,
      send: async body => { sent.push(body); return failure; }
    });
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1].toString()).input).toEqual([{ type: "compaction", encrypted_content: "opaque-compaction" }]);
    expect(recovery.result).toBe(failure);
    expect(recovery.unavailable).toBe(true);
  });

  it("reclassifies decryption errors after resource-ID repair", async () => {
    const summary = "The previous work is preserved in this readable summary.";
    const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [{ type: "compaction", id: "cmp_a", encrypted_content: summary }] }));
    const sent: Array<Record<string, unknown>> = [];
    const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "same", canReplay: () => true,
      startGenericRecovery: () => { throw new Error("resource repair must not enable generic fallback"); },
      send: async body => {
        sent.push(JSON.parse(body.toString()));
        if (sent.length === 1) return upstreamResult(400, agentrouterResourceErrorCases[0].response);
        if (sent.length === 2) return upstreamResult(400, { error: { type: "invalid_request_error", code: null,
          message: "The encrypted content gAAA...8A== could not be verified. Reason: Encrypted content could not be decrypted or parsed." } });
        return upstreamResult(200, { output: [] });
      }
    });
    expect(sent).toHaveLength(3);
    expect(sent[1].input).toEqual([{ type: "compaction", encrypted_content: summary }]);
    expect(sent[2].input).toEqual([{ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] }]);
    expect(recovery.result.status).toBe(200);
    expect(recovery.policy?.stripCompactionIds).toBe(true);
  });

  it("accumulates targeted reasoning repairs without touching other state", async () => {
    const input = [0, 1, 2].map(i => ({ type: "reasoning", id: `rs_${i}`, encrypted_content: `opaque_${i}`, summary: [] }));
    const compaction = { type: "compaction", encrypted_content: "opaque-compaction" };
    const sent: Array<{ input: unknown[] }> = [];
    const recovery = await runProviderStateMigration({ canonicalBody: Buffer.from(JSON.stringify({ input: [...input, compaction] })),
      targetStateDomain: "same", canReplay: () => true, startGenericRecovery: () => null,
      send: async body => {
        sent.push(JSON.parse(body.toString()));
        return sent.length <= 2 ? upstreamResult(400, { error: { type: "invalid_request_error", code: null,
          message: `The encrypted content for item rs_${sent.length - 1} could not be verified.` } }) : upstreamResult(200, { output: [] });
      }
    });
    expect(sent).toHaveLength(3);
    expect(sent[2].input).toEqual([input[2], compaction]);
    expect(recovery.policy?.priorEncryptedFailures).toHaveLength(1);
  });

  it("does not infer compaction rejection from a locator that does not match input", async () => {
    const canonicalBody = Buffer.from(JSON.stringify({ input: [{ type: "compaction", encrypted_content: "opaque-state" }] }));
    let sends = 0;
    const recovery = await runProviderStateMigration({ canonicalBody, targetStateDomain: "same", canReplay: () => true,
      startGenericRecovery: () => null, send: async body => {
        sends++; expect(body).toBe(canonicalBody);
        return upstreamResult(400, { error: { type: "invalid_request_error", code: null,
          message: "The encrypted content for item cmp_other could not be verified." } });
      }
    });
    expect(sends).toBe(1);
    expect(recovery.unavailable).not.toBe(true);
  });

  it("never sends more than four different attempts even when every response names a new rejected item", async () => {
    let sends = 0;
    const recovery = await runProviderStateMigration({ canonicalBody: Buffer.from(JSON.stringify({ input:
      Array.from({ length: 5 }, (_, i) => ({ type: "reasoning", id: `rs_${i}`, encrypted_content: `state_${i}` })) })),
      targetStateDomain: "same", canReplay: () => true, startGenericRecovery: () => null,
      send: async () => upstreamResult(400, { error: { type: "invalid_request_error",
        message: `The encrypted content for item rs_${sends++} could not be verified.` } })
    });
    expect(sends).toBe(4);
    expect(new Set(recovery.attempts.map(attempt => attempt.bodyHash)).size).toBe(4);
  });

  it.each(["success", "same-error", "cancelled", "truncated", "encrypted-only"])(
    "handles agent hydration failure with bounded recovery: %s", async (scenario) => {
      const item = scenario === "encrypted-only"
        ? { ...encryptedAgentMessage, content: [encryptedAgentMessage.content[1]] }
        : encryptedAgentMessage;
      const canonicalBody = Buffer.from(JSON.stringify({ store: false, input: [item,
        ...(scenario === "truncated" ? [{ type: "reasoning", encrypted_content: "opaque-reasoning" }] : [])
      ] }));
      const sent: Buffer[] = [];
      const failure = { ...upstreamResult(400, encryptedAgentError), responseBodyTruncated: scenario === "truncated" };
      const recovery = await runProviderStateMigration({
        canonicalBody, targetStateDomain: "same-domain", canReplay: () => scenario !== "cancelled",
        startGenericRecovery: () => null,
        send: async (body) => {
          sent.push(body);
          return sent.length === 1 || scenario !== "success" ? failure : upstreamResult(200, { output: [] });
        }
      });
      const retry = scenario === "success" || scenario === "same-error";
      expect(sent).toHaveLength(retry ? 2 : 1);
      expect(sent[0]).toBe(canonicalBody);
      if (retry) {
        expect(JSON.parse(sent[1].toString()).input).toEqual([{
          ...encryptedAgentMessage, content: [encryptedAgentMessage.content[0]]
        }]);
        expect(recovery.attempts[1].compiled.fidelity).toBe("degraded");
      }
      if (scenario !== "success") expect(recovery.result).toBe(failure);
    }
  );

  it("can use all four distinct attempts without mutating prior bodies", async () => {
    const canonicalBody = canonicalStatefulBody();
    const sentBodies: Buffer[] = [];
    const results = [
      upstreamResult(502, { error: { code: "upstream_error" } }),
      upstreamResult(400, { error: { code: "invalid_encrypted_content" } }),
      upstreamResult(502, { error: { code: "upstream_error" } }),
      upstreamResult(502, { error: { code: "upstream_error" } })
    ];

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => true,
      startGenericRecovery: () => "profile_switch_failure",
      send: async (body) => {
        sentBodies.push(body);
        return results[sentBodies.length - 1];
      }
    });

    expect(recovery.attempts.map((attempt) => attempt.strategy)).toEqual([
      "original",
      "cpa",
      "error_400",
      "cross_domain"
    ]);
    expect(sentBodies[0]).toBe(canonicalBody);
    expect(new Set(sentBodies.map(hashProviderStateBody))).toHaveLength(4);
    expect(recovery.trigger).toBe("profile_switch_failure");
  });

  it("skips duplicate CPA and error-specific bodies without resending them", async () => {
    const canonicalBody = Buffer.from(JSON.stringify({
      input: [{ type: "reasoning", encrypted_content: validEncryptedContent() }]
    }));
    const sentBodies: Buffer[] = [];

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => true,
      startGenericRecovery: () => "profile_switch_failure",
      send: async (body, strategy) => {
        sentBodies.push(body);
        return strategy === "original"
          ? upstreamResult(502, { error: { code: "upstream_error" } })
          : upstreamResult(400, { error: { code: "invalid_encrypted_content" } });
      }
    });

    expect(recovery.attempts.map((attempt) => attempt.strategy)).toEqual([
      "original",
      "cross_domain"
    ]);
    expect(sentBodies).toHaveLength(2);
    expect(recovery.result.status).toBe(400);
  });

  it("returns the original failure when generic recovery evidence is absent", async () => {
    const canonicalBody = canonicalStatefulBody();
    let sends = 0;

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => true,
      startGenericRecovery: () => null,
      send: async (body) => {
        sends += 1;
        expect(body).toBe(canonicalBody);
        return upstreamResult(502, { error: { code: "upstream_error" } });
      }
    });

    expect(sends).toBe(1);
    expect(recovery.trigger).toBeNull();
    expect(recovery.result.status).toBe(502);
  });

  it("does not replay when the downstream guard rejects another attempt", async () => {
    const canonicalBody = canonicalStatefulBody();
    let sends = 0;

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => false,
      startGenericRecovery: () => "profile_switch_failure",
      send: async () => {
        sends += 1;
        return upstreamResult(502, { error: { code: "upstream_error" } });
      }
    });

    expect(sends).toBe(1);
    expect(recovery.trigger).toBeNull();
    expect(recovery.result.status).toBe(502);
  });

  it("keeps explicit_400 as the initial trigger when strict recovery follows", async () => {
    const canonicalBody = canonicalStatefulBody();
    const results = [
      upstreamResult(400, { error: { code: "invalid_encrypted_content" } }),
      upstreamResult(502, { error: { code: "upstream_error" } }),
      upstreamResult(200, { id: "resp_recovered" })
    ];
    let sends = 0;

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => true,
      startGenericRecovery: () => "profile_switch_failure",
      send: async () => results[sends++]
    });

    expect(recovery.attempts.map((attempt) => attempt.strategy)).toEqual([
      "original",
      "error_400",
      "cross_domain"
    ]);
    expect(recovery.trigger).toBe("explicit_400");
    expect(recovery.result.status).toBe(200);
  });

  it("repairs invalid_responses_request only when canonical input carries compaction", async () => {
    const canonicalBody = canonicalCompactionBody();
    const sentBodies: Buffer[] = [];

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => true,
      startGenericRecovery: () => null,
      send: async (body) => {
        sentBodies.push(body);
        return sentBodies.length === 1
          ? upstreamResult(400, { error: { code: "invalid_responses_request" } })
          : upstreamResult(200, { id: "resp_recovered" });
      }
    });

    expect(recovery.attempts.map((attempt) => attempt.strategy)).toEqual([
      "original",
      "error_400"
    ]);
    expect(sentBodies[0]).toBe(canonicalBody);
    expect(JSON.parse(sentBodies[1].toString("utf8")).input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "The previous work is preserved in this readable summary." }] },
      { type: "message", role: "user", content: "continue" }
    ]);
    expect(recovery.attempts[1].compiled.fidelity).toBe("summary");
    expect(recovery.trigger).toBe("explicit_400");
  });

  it("does not recover invalid_responses_request without compaction", async () => {
    const canonicalBody = canonicalStatefulBody();
    let sends = 0;

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => true,
      startGenericRecovery: () => {
        throw new Error("generic recovery must not be evaluated");
      },
      send: async () => {
        sends += 1;
        return upstreamResult(400, { error: { code: "invalid_responses_request" } });
      }
    });

    expect(sends).toBe(1);
    expect(recovery.trigger).toBeNull();
    expect(recovery.result.status).toBe(400);
  });

  it("stops when compaction restoration receives the same invalid_responses_request", async () => {
    const canonicalBody = canonicalCompactionBody();
    let sends = 0;

    const recovery = await runProviderStateMigration({
      canonicalBody,
      targetStateDomain: "target",
      canReplay: () => true,
      startGenericRecovery: () => "profile_switch_failure",
      send: async () => {
        sends += 1;
        return upstreamResult(400, { error: { code: "invalid_responses_request" } });
      }
    });

    expect(sends).toBe(2);
    expect(recovery.attempts.map((attempt) => attempt.strategy)).toEqual([
      "original",
      "error_400"
    ]);
    expect(recovery.result.status).toBe(400);
  });
});

describe.each(agentrouterResourceErrorCases)("global compaction ID recovery ($name)", ({ response: error }) => {
  const request = () => ({
    model: "synthetic-model", store: false, previous_response_id: null,
    input: [
      { type: "reasoning", id: "rs_keep", encrypted_content: null, summary: [] },
      { type: "compaction", id: "cmp_remove", encrypted_content: "opaque-state" },
      { type: "custom_tool_call", id: "ct_keep", call_id: "call_keep", name: "exec", input: "1" },
      { type: "custom_tool_call_output", call_id: "call_keep", output: "ok" },
      { type: "message", role: "user", content: "continue" }
    ]
  });

  it.each([200, 400, 502])("retries only compaction IDs once and stops at HTTP %s", async (retryStatus) => {
    const original = request();
    const canonicalBody = Buffer.from(JSON.stringify(original));
    const sent: Buffer[] = [];
    const recovery = await runProviderStateMigration({
      canonicalBody, targetStateDomain: "same-domain",
      canReplay: () => true,
      startGenericRecovery: () => { throw new Error("must not run broader cleanup"); },
      send: async (body) => {
        sent.push(body);
        return sent.length === 1 ? upstreamResult(400, error) : upstreamResult(retryStatus, error);
      }
    });
    const expected = request();
    delete expected.input[1].id;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(canonicalBody);
    expect(JSON.parse(canonicalBody.toString())).toEqual(original);
    expect(JSON.parse(sent[1].toString())).toEqual(expected);
    expect(recovery.body).toBe(sent[1]);
    expect(recovery.result.status).toBe(retryStatus);
    expect(recovery.trigger).toBe("explicit_400");
    expect(recovery.attempts.map((attempt) => attempt.strategy)).toEqual(["original", "error_400"]);
    expect(recovery.attempts[1].compiled.fidelity).toBe("exact");
    expect(Object.entries(recovery.attempts[1].compiled.metrics).filter(([, count]) => count > 0))
      .toEqual([["providerItemIdsRemoved", 1]]);
  });

  it.each([
    "other-error", "success", "status-500", "cancelled",
    "truncated", "deadline-during-repair", "store-true", "store-absent", "reference", "untyped-reference", "continuation",
    "no-id", "no-ciphertext"
  ])("does not perform the ID repair for %s", async (scenario) => {
    const body: Record<string, unknown> = request();
    const input = body.input as Array<Record<string, unknown>>;
    let result = upstreamResult(400, error);
    if (scenario === "other-error") result = upstreamResult(400, { error: { type: "invalid_request_error", message: "bad input" } });
    if (scenario === "success") result = upstreamResult(200, { output: [] });
    if (scenario === "status-500") result.status = 500;
    if (scenario === "truncated") result.responseBodyTruncated = true;
    if (scenario === "store-true") body.store = true;
    if (scenario === "store-absent") delete body.store;
    if (scenario === "reference") input.push({ type: "item_reference", id: "cmp_remove" });
    if (scenario === "untyped-reference") input.push({ id: "cmp_remove" });
    if (scenario === "continuation") body.previous_response_id = "resp_keep";
    if (scenario === "no-id") delete input[1].id;
    if (scenario === "no-ciphertext") delete input[1].encrypted_content;
    const canonicalBody = Buffer.from(JSON.stringify(body));
    let sends = 0;
    let replayChecks = 0;
    const recovery = await runProviderStateMigration({
      canonicalBody, targetStateDomain: "same-domain",
      canReplay: () => scenario !== "cancelled" &&
        (scenario !== "deadline-during-repair" || replayChecks++ === 0),
      startGenericRecovery: () => {
        if (["store-true", "store-absent", "reference", "untyped-reference", "continuation", "no-id", "no-ciphertext"].includes(scenario)) {
          throw new Error("recognized Azure failures must not reach broader cleanup");
        }
        return null;
      },
      send: async (sent) => { sends += 1; expect(sent).toBe(canonicalBody); return result; }
    });
    expect(sends).toBe(1);
    expect(recovery.result).toBe(result);
  });

  it("recognizes gzip errors without changing encrypted context", async () => {
    let sends = 0;
    const recovery = await runProviderStateMigration({
      canonicalBody: Buffer.from(JSON.stringify(request())),
      targetStateDomain: "same-domain", canReplay: () => true, startGenericRecovery: () => null,
      send: async () => {
        sends += 1;
        return sends === 1 ? { ...upstreamResult(400, error), responseBody: gzipSync(JSON.stringify(error)) }
          : upstreamResult(200, { output: [] });
      }
    });
    expect(sends).toBe(2);
    expect(JSON.parse(recovery.body.toString()).input[1]).toEqual({ type: "compaction", encrypted_content: "opaque-state" });
  });
});

describe("provider-state recovery evidence", () => {
  const scope = {
    targetStateDomain: "provider-target",
    model: "gpt-5.5",
    endpoint: "responses"
  };

  it("uses only hashed stable evidence keys", () => {
    const result = upstreamResult(502, { error: { code: "upstream_error" } });
    const healthKey = providerStateTargetHealthKey(scope);
    const failureKey = providerStateLegacyFailureKey(scope, "sha256:conversation", result);

    expect(healthKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(failureKey).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(`${healthKey}${failureKey}`).not.toContain("provider-target");
  });

  it("restricts generic recovery to approved state-like failures", () => {
    const cases: Array<[BufferedUpstreamResult, boolean]> = [
      [upstreamResult(502, { error: { code: "upstream_error" } }), true],
      [upstreamResult(422, { error: { code: "request_shape" } }), true],
      [upstreamResult(503, { error: { code: "service_unavailable" } }), false],
      [upstreamResult(502, { error: { message: "invalid api key" } }), false],
      [upstreamResult(502, { error: { code: "insufficient_quota" } }), false],
      [upstreamResult(502, { error: { code: "rate_limit_exceeded" } }), false],
      [upstreamResult(400, { error: { code: "invalid_model" } }), false],
      [upstreamResult(400, { error: { code: "unsupported_endpoint" } }), false],
      [upstreamResult(400, { error: { code: "invalid_encrypted_content" } }), false],
      [{ ...upstreamResult(502, { error: "truncated" }), responseBodyTruncated: true }, false]
    ];

    for (const [result, expected] of cases) {
      expect(isEligibleGenericProviderStateFailure(result)).toBe(expected);
    }
    expect(isEligibleGenericProviderStateFailure(
      upstreamResult(400, { error: { code: "invalid_encrypted_content" } }),
      true
    )).toBe(true);
  });
});
