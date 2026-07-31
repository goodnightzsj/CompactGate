import { describe, expect, it } from "vitest";
import {
  runProviderStateMigration
} from "../src/server/provider-state-migration.js";
import { hashProviderStateBody } from "../src/server/provider-state-portability.js";
import {
  isEligibleGenericProviderStateFailure,
  providerStateLegacyFailureKey,
  providerStateTargetHealthKey
} from "../src/server/provider-state-evidence.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";

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
        summary: []
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

describe("provider-state recovery state machine", () => {
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
