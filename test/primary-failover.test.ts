import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import {
  CompactionBridgeStore,
  UnresolvedCompactionStateError
} from "../src/server/compaction-bridge.js";
import { buildPrimaryOpenAiProxyPlan } from "../src/server/openai-proxy-plan.js";
import {
  classifyPrimaryRouteResult,
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody
} from "../src/server/primary-failover.js";
import type { CompactGateConfig, SavedConfigProfile } from "../src/shared/types.js";
import { compactUpstreamBaseUrl, deriveCompactModel } from "../src/server/routing.js";

describe("PrimaryFailoverState", () => {
  it("releases its reservation when local bridge validation rejects the plan", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    config.compact.upstream_mode = "split";
    const state = new PrimaryFailoverState({ random: () => 0 });
    const bridge = new CompactionBridgeStore();
    const sourceModel = "gpt-5.5";
    const encryptedContent = "KNOWN_WITHOUT_FALLBACK";
    bridge.storeCompactResponse(Buffer.from(JSON.stringify({
      output: [{ type: "compaction", encrypted_content: encryptedContent }]
    })), {
      scope: {
        compactUpstream: compactUpstreamBaseUrl(config),
        sourceModel,
        targetModel: deriveCompactModel(sourceModel, config)
      }
    });
    const rawBody = Buffer.from(JSON.stringify({
      model: sourceModel,
      input: [{ type: "compaction", encrypted_content: encryptedContent }]
    }));

    expect(() => buildPrimaryOpenAiProxyPlan({
      config,
      url: new URL("http://compactgate.local/v1/responses"),
      headers: { "content-type": "application/json" },
      rawBody,
      endpoint: "/responses",
      compactionBridge: bridge,
      primaryFailover: state
    })).toThrow(UnresolvedCompactionStateError);

    expect(state.getHealthSnapshot().find((entry) => entry.profileId === "codex-a"))
      .toMatchObject({ inFlight: 0 });
  });

  it("resets empty-stream failure counts after a successful primary stream", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    recordRequests(state, config, 10, 200, "OpenAI stream closed before response.completed.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    state.recordResult(state.select(config, { model: "gpt-5.5" }), 200, null);
    recordRequests(state, config, 10, 200, "OpenAI stream closed before response.completed.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      200,
      "OpenAI stream closed before response.completed."
    );
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
  });

  it("quarantines auth and balance failures after more than ten standalone errors", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    recordRequests(
      state,
      config,
      10,
      403,
      "Upstream returned HTTP 403: insufficient balance."
    );
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      403,
      "Upstream returned HTTP 403: insufficient balance."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    expect(state.getHealthSnapshot().find((entry) => entry.profileId === "codex-a")).toMatchObject({
      quarantineUntil: expect.any(Number)
    });

    recordRequests(
      state,
      config,
      10,
      401,
      "Upstream returned HTTP 401: invalid token."
    );
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");

    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      401,
      "Upstream returned HTTP 401: invalid token."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("keeps the active profile when automatic scheduling is disabled", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    config.primary_failover.auto_schedule = false;
    const { state } = createState();

    recordRequests(
      state,
      config,
      12,
      403,
      "Upstream returned HTTP 403: insufficient balance."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("resets primary health when the effective profile credential changes", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "bad-key"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "fallback-key")
    ]);
    const { state } = createState();

    recordRequests(
      state,
      config,
      11,
      401,
      "Upstream returned HTTP 401: invalid token."
    );
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");

    const rotatedConfig = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "good-key"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "fallback-key")
    ]);

    expect(state.preview(rotatedConfig, { model: "gpt-5.5" }).profileId).toBe("codex-a");
    expect(state.getHealthSnapshot().find((entry) => entry.profileId === "codex-a")).toMatchObject({
      quarantineUntil: 0
    });
  });

  it("preserves primary health when only the active profile rotates", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "bad-key"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "fallback-key")
    ]);
    const { state } = createState();

    recordRequests(
      state,
      config,
      11,
      401,
      "Upstream returned HTTP 401: invalid token."
    );
    const quarantineUntil = state.getHealthSnapshot()
      .find((entry) => entry.profileId === "codex-a")?.quarantineUntil;

    const rotatedConfig = cloneConfig(config);
    if (!rotatedConfig.profile_scopes?.codex) {
      throw new Error("Expected Codex profile scope.");
    }
    rotatedConfig.profile_scopes.codex.active_profile_id = "codex-b";

    expect(state.preview(rotatedConfig, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    expect(state.getHealthSnapshot().find((entry) => entry.profileId === "codex-a")).toMatchObject({
      quarantineUntil
    });
  });

  it("starts from the active profile and then falls forward through saved order", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1"),
      codexProfile("codex-c", "Codex C", "http://127.0.0.1:9103/v1")
    ], "codex-b");
    const { state } = createState();

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    recordRequests(
      state,
      config,
      11,
      403,
      "Upstream returned HTTP 403: insufficient balance."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-c");
  });

  it("honors Retry-After for rate limits and returns after cooldown expires", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    for (let index = 0; index < 10; index += 1) {
      clock.state.recordResult(
        clock.state.select(config, { model: "gpt-5.5" }),
        {
          status: 429,
          errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
          responseHeaders: { "retry-after": "2" }
        }
      );
    }
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    recordRateLimitFailures(clock.state, config, 1);

    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    clock.advance(2_100);
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("ignores malformed Retry-After delay values for rate-limit cooldowns", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    for (let index = 0; index < 10; index += 1) {
      clock.state.recordResult(
        clock.state.select(config, { model: "gpt-5.5" }),
        {
          status: 429,
          errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
          responseHeaders: { "retry-after": "1e6" }
        }
      );
    }
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    clock.state.recordResult(
      clock.state.select(config, { model: "gpt-5.5" }),
      {
        status: 429,
        errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
        responseHeaders: { "retry-after": "1e6" }
      }
    );

    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    clock.advance(60_100);
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("disables an incompatible model without poisoning the whole profile", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    recordModelRequests(
      state,
      config,
      "gpt-missing",
      10,
      404,
      "Upstream returned HTTP 404: model gpt-missing not found."
    );
    expect(state.preview(config, { model: "gpt-missing" }).profileId).toBe("codex-a");

    state.recordResult(
      state.select(config, { model: "gpt-missing" }),
      404,
      "Upstream returned HTTP 404: model gpt-missing not found."
    );

    expect(state.preview(config, { model: "gpt-missing" }).profileId).toBe("codex-b");
    expect(state.preview(config, { model: "gpt-available" }).profileId).toBe("codex-a");
  });

  it("ignores request-shape errors for profile health", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      400,
      "Upstream returned HTTP 400: input is required."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
    expect(state.getHealthSnapshot().find((entry) => entry.profileId === "codex-a")).toMatchObject({
      cooldownUntil: 0,
      quarantineUntil: 0,
      transientFailures: 0
    });
  });

  it("keeps session traffic sticky while the profile remains healthy", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    recordRateLimitFailures(clock.state, config);

    const selection = clock.state.select(config, {
      model: "gpt-5.5",
      sessionKey: "session-one"
    });
    expect(selection.profileId).toBe("codex-b");
    clock.state.recordResult(selection, 200, null);
    clock.advance(2_100);

    expect(clock.state.preview(config, {
      model: "gpt-5.5",
      sessionKey: "session-one"
    }).profileId).toBe("codex-b");
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("sticks previous_response_id to the profile that produced the response id", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    recordRateLimitFailures(clock.state, config);

    const selection = clock.state.select(config, { model: "gpt-5.5" });
    expect(selection.profileId).toBe("codex-b");
    clock.state.recordResult(selection, {
      status: 200,
      errorSummary: null,
      responseBody: Buffer.from(JSON.stringify({ id: "resp-123" })),
      responseHeaders: { "content-type": "application/json" }
    });
    clock.advance(2_100);

    expect(clock.state.preview(config, {
      model: "gpt-5.5",
      previousResponseId: "resp-123"
    }).profileId).toBe("codex-b");
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("sticks gzip encoded response ids to the profile that produced them", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    recordRateLimitFailures(clock.state, config);

    const selection = clock.state.select(config, { model: "gpt-5.5" });
    expect(selection.profileId).toBe("codex-b");
    clock.state.recordResult(selection, {
      status: 200,
      errorSummary: null,
      responseBody: gzipSync(Buffer.from(JSON.stringify({ id: "resp-gzip-produced" }))),
      responseHeaders: {
        "content-type": "application/json",
        "content-encoding": "gzip"
      }
    });
    clock.advance(2_100);

    expect(clock.state.preview(config, {
      model: "gpt-5.5",
      previousResponseId: "resp-gzip-produced"
    }).profileId).toBe("codex-b");
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("sticks compaction state to the primary profile that successfully handled it", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);
    const compactionContext = {
      model: "gpt-5.5",
      compactionStateKey: "sha256:opaque-compact-state"
    };

    recordRateLimitFailures(clock.state, config);

    const selection = clock.state.select(config, compactionContext);
    expect(selection.profileId).toBe("codex-b");
    clock.state.recordResult(selection, 200, null);
    clock.advance(2_100);

    expect(clock.state.preview(config, compactionContext).profileId).toBe("codex-b");
    expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("bounds sticky state by evicting the oldest session and continuation entries", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000, { maxStickyEntries: 2 });

    recordRateLimitFailures(clock.state, config);

    for (const sessionKey of ["session-0", "session-1", "session-2"]) {
      const selection = clock.state.select(config, { model: "gpt-5.5", sessionKey });
      expect(selection.profileId).toBe("codex-b");
      clock.state.recordResult(selection, 200, null);
    }

    clock.advance(2_100);
    expect(clock.state.preview(config, { model: "gpt-5.5", sessionKey: "session-0" }).profileId)
      .toBe("codex-a");
    expect(clock.state.preview(config, { model: "gpt-5.5", sessionKey: "session-1" }).profileId)
      .toBe("codex-b");
    expect(clock.state.preview(config, { model: "gpt-5.5", sessionKey: "session-2" }).profileId)
      .toBe("codex-b");

    const continuationClock = createState(1_000, { maxStickyEntries: 2 });
    recordRateLimitFailures(continuationClock.state, config);

    for (const responseId of ["resp-0", "resp-1", "resp-2"]) {
      const selection = continuationClock.state.select(config, { model: "gpt-5.5" });
      expect(selection.profileId).toBe("codex-b");
      continuationClock.state.recordResult(selection, {
        status: 200,
        errorSummary: null,
        responseId
      });
    }

    continuationClock.advance(2_100);
    expect(continuationClock.state.preview(config, {
      model: "gpt-5.5",
      previousResponseId: "resp-0"
    }).profileId).toBe("codex-a");
    expect(continuationClock.state.preview(config, {
      model: "gpt-5.5",
      previousResponseId: "resp-1"
    }).profileId).toBe("codex-b");
    expect(continuationClock.state.preview(config, {
      model: "gpt-5.5",
      previousResponseId: "resp-2"
    }).profileId).toBe("codex-b");

    const compactionClock = createState(1_000, { maxStickyEntries: 2 });
    recordRateLimitFailures(compactionClock.state, config);

    for (const compactionStateKey of ["sha256:state-0", "sha256:state-1", "sha256:state-2"]) {
      const selection = compactionClock.state.select(config, { model: "gpt-5.5", compactionStateKey });
      expect(selection.profileId).toBe("codex-b");
      compactionClock.state.recordResult(selection, 200, null);
    }

    compactionClock.advance(2_100);
    expect(compactionClock.state.preview(config, {
      model: "gpt-5.5",
      compactionStateKey: "sha256:state-0"
    }).profileId).toBe("codex-a");
    expect(compactionClock.state.preview(config, {
      model: "gpt-5.5",
      compactionStateKey: "sha256:state-1"
    }).profileId).toBe("codex-b");
    expect(compactionClock.state.preview(config, {
      model: "gpt-5.5",
      compactionStateKey: "sha256:state-2"
    }).profileId).toBe("codex-b");
  });

  it("bounds model cooldown state by evicting the oldest incompatible models", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState(1_000, { maxModelCooldownEntries: 2 });

    recordRequests(
      state,
      config,
      11,
      403,
      "Upstream returned HTTP 403: insufficient balance."
    );

    for (const model of ["missing-0", "missing-1", "missing-2"]) {
      for (let index = 0; index < 11; index += 1) {
        const selection = state.select(config, { model });
        expect(selection.profileId).toBe("codex-b");
        state.recordResult(
          selection,
          404,
          `Upstream returned HTTP 404: model ${model} not found.`
        );
      }
    }

    expect(state.preview(config, { model: "missing-0" }).profileId).toBe("codex-b");
    expect(state.preview(config, { model: "missing-1" }).profileId).toBe("codex-a");
    expect(state.preview(config, { model: "missing-2" }).profileId).toBe("codex-a");
    expect(state.getHealthSnapshot().find((entry) => entry.profileId === "codex-b")?.modelCooldowns)
      .toEqual([
        expect.objectContaining({ model: "missing-1" }),
        expect.objectContaining({ model: "missing-2" })
      ]);
  });
});

describe("primary route result classification", () => {
  it("separates quota, auth, rate-limit, model, request-shape, and client-cancel failures", () => {
    expect(classifyPrimaryRouteResult({
      status: 403,
      errorSummary: "Upstream returned HTTP 403: insufficient balance."
    })).toBe("quota");
    expect(classifyPrimaryRouteResult({
      status: 401,
      errorSummary: "Upstream returned HTTP 401: invalid token."
    })).toBe("auth");
    expect(classifyPrimaryRouteResult({
      status: 429,
      errorSummary: "Upstream returned HTTP 429: rate limit."
    })).toBe("rate_limit");
    expect(classifyPrimaryRouteResult({
      status: 200,
      errorSummary: "OpenAI stream response was not text/event-stream."
    })).toBe("transient");
    expect(classifyPrimaryRouteResult({
      status: 404,
      errorSummary: "Upstream returned HTTP 404: model gpt-x not found."
    })).toBe("model_incompatible");
    expect(classifyPrimaryRouteResult({
      status: 422,
      errorSummary: "Upstream returned HTTP 422: invalid request body."
    })).toBe("request_shape");
    expect(classifyPrimaryRouteResult({
      status: 502,
      errorSummary: "Client disconnected before upstream response completed."
    })).toBe("client_cancel");
    expect(classifyPrimaryRouteResult({
      status: 200,
      errorSummary: "OpenAI stream ended with response.failed.",
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: null,
        cachedOutputTokens: null,
        cacheReadInputTokens: null,
        cacheCreationInputTokens: null,
        reasoningTokens: null,
        totalTokens: 13
      }
    })).toBe("success");
  });
});

describe("primaryRouteRequestContextFromBody", () => {
  it("extracts model, previous response id, and session key from body and headers", () => {
    const context = primaryRouteRequestContextFromBody(
      Buffer.from(JSON.stringify({
        model: "gpt-5.5",
        previous_response_id: "resp-old",
        input: [
          { type: "compaction", encrypted_content: "OPAQUE_REMOTE_STATE" },
          { type: "message", role: "user" }
        ],
        metadata: { session_hash: "body-session" }
      })),
      { "x-session-id": "header-session" },
      "/responses"
    );

    expect(context).toEqual({
      endpoint: "/responses",
      model: "gpt-5.5",
      previousResponseId: "resp-old",
      sessionKey: "body-session",
      compactionStateKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    expect(context.compactionStateKey).not.toContain("OPAQUE_REMOTE_STATE");
  });

  it("extracts sticky context from gzip encoded primary request bodies", () => {
    const context = primaryRouteRequestContextFromBody(
      gzipSync(Buffer.from(JSON.stringify({
        model: "gpt-5.5",
        previous_response_id: "resp-gzip-old",
        input: [
          { type: "compaction", encrypted_content: "OPAQUE_GZIP_STATE" },
          { type: "message", role: "user" }
        ],
        metadata: { session_hash: "gzip-body-session" }
      }))),
      { "x-session-id": "gzip-header-session" },
      "/responses"
    );

    expect(context).toEqual({
      endpoint: "/responses",
      model: "gpt-5.5",
      previousResponseId: "resp-gzip-old",
      sessionKey: "gzip-body-session",
      compactionStateKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    expect(context.compactionStateKey).not.toContain("OPAQUE_GZIP_STATE");
  });
});

function createState(
  startNow = 0,
  options: { maxStickyEntries?: number; maxModelCooldownEntries?: number } = {}
): {
  state: PrimaryFailoverState;
  advance: (ms: number) => void;
} {
  let now = startNow;
  return {
    state: new PrimaryFailoverState({
      now: () => now,
      random: () => 0,
      ...options
    }),
    advance: (ms: number) => {
      now += ms;
    }
  };
}

function recordRequests(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  count: number,
  status: number,
  errorSummary: string | null
): void {
  for (let index = 0; index < count; index += 1) {
    state.recordResult(state.select(config, { model: "gpt-5.5" }), status, errorSummary);
  }
}

function recordModelRequests(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  model: string,
  count: number,
  status: number,
  errorSummary: string | null
): void {
  for (let index = 0; index < count; index += 1) {
    state.recordResult(state.select(config, { model }), status, errorSummary);
  }
}

function recordRateLimitFailures(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  count = 11
): void {
  for (let index = 0; index < count; index += 1) {
    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      {
        status: 429,
        errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
        responseHeaders: { "retry-after": "2" }
      }
    );
  }
}

function configWithCodexProfiles(
  profiles: SavedConfigProfile[],
  activeProfileId = profiles[0]?.id ?? null
): CompactGateConfig {
  return {
    ...cloneConfig(DEFAULT_CONFIG),
    profile_scopes: {
      codex: {
        profiles,
        active_profile_id: activeProfileId
      },
      claude: {
        profiles: [],
        active_profile_id: null
      }
    }
  };
}

function codexProfile(
  id: string,
  name: string,
  primaryBaseUrl: string,
  primaryApiKey = DEFAULT_CONFIG.primary.api_key
): SavedConfigProfile {
  return {
    id,
    name,
    created_at: "2026-06-06T00:00:00.000Z",
    updated_at: "2026-06-06T00:00:00.000Z",
    config: {
      primary: {
        ...DEFAULT_CONFIG.primary,
        base_url: primaryBaseUrl,
        api_key: primaryApiKey
      },
      compact: { ...DEFAULT_CONFIG.compact }
    }
  };
}

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}
