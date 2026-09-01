import { gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import {
  CompactionBridgeStore,
  UnresolvedCompactionStateError
} from "../src/server/compaction-bridge.js";
import { buildPrimaryOpenAiProxyPlan } from "../src/server/openai-proxy-plan.js";
import {
  candidateSignature,
  codexPrimaryCandidates
} from "../src/server/primary-failover-candidates.js";
import {
  classifyPrimaryRouteResult,
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody
} from "../src/server/primary-failover.js";
import type { PrimaryRouteRequestContext } from "../src/server/primary-failover.js";
import type {
  CompactGateConfig,
  PrimaryReasoningEffort,
  SavedConfigProfile
} from "../src/shared/types.js";
import { compactUpstreamBaseUrl, deriveCompactModel } from "../src/server/routing.js";

describe("PrimaryFailoverState", () => {
  it("changes candidate signatures when protocol or transport settings change", () => {
    const base = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "https://api.example.test/v1")
    ]);
    const changed = cloneConfig(base);
    const profile = changed.profile_scopes?.codex?.profiles?.[0];
    if (!profile || !("primary" in profile.config)) {
      throw new Error("Expected Codex profile primary config.");
    }
    profile.config.primary.upstream_protocol = "openai_chat";
    profile.config.primary.extra_headers = { "x-route": "changed" };
    profile.config.primary.proxy_url = "http://127.0.0.1:8080";

    expect(candidateSignature(codexPrimaryCandidates(changed))).not.toBe(
      candidateSignature(codexPrimaryCandidates(base))
    );
  });

  it("applies the selected Codex profile reasoning effort to Responses plans", () => {
    const config = configWithCodexProfiles([
      codexProfile(
        "codex-reasoning",
        "Codex reasoning",
        "http://127.0.0.1:9101/v1",
        DEFAULT_CONFIG.primary.api_key,
        "xhigh"
      )
    ]);
    const state = new PrimaryFailoverState({ random: () => 0 });
    const plan = buildPrimaryOpenAiProxyPlan({
      config,
      url: new URL("http://compactgate.local/v1/responses"),
      headers: { "content-type": "application/json" },
      rawBody: Buffer.from(JSON.stringify({
        model: "gpt-5.6-sol",
        input: "redacted",
        reasoning: { summary: "auto" }
      })),
      endpoint: "/responses",
      compactionBridge: new CompactionBridgeStore(),
      primaryFailover: state
    });

    expect(plan.primarySelection?.profileId).toBe("codex-reasoning");
    expect(JSON.parse(plan.upstreamBody.toString("utf8"))).toMatchObject({
      reasoning: { summary: "auto", effort: "xhigh" }
    });
  });

  it("rejects plans whose split compaction state cannot be bridged locally", () => {
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
  });

  it("resets empty-stream failure counts after a successful primary stream", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    recordRequests(state, config, 10, 200, "OpenAI stream closed before response.completed.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    state.recordResult(selectAndReserve(state, config, { model: "gpt-5.5" }), 200, null);
    recordRequests(state, config, 10, 200, "OpenAI stream closed before response.completed.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    state.recordResult(
      selectAndReserve(state, config, { model: "gpt-5.5" }),
      200,
      "OpenAI stream closed before response.completed."
    );
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
  });

  it("discards a verdict earned before the profile was disabled and re-enabled", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();
    const selection = selectAndReserve(state, config, { model: "gpt-5.5" });
    expect(selection.profileId).toBe("codex-a");

    // A drops out, then returns. Removal used to skip the generation bump on the
    // reasoning that a missing health record makes `recordResult` no-op, and the
    // return was not a *change* either, because `signatures` had forgotten the id.
    const withoutA = configWithCodexProfiles(
      [codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")],
      "codex-b"
    );
    state.preview(withoutA, { model: "gpt-5.5" });
    state.preview(config, { model: "gpt-5.5" });

    state.recordResult(selection, 403, "Upstream returned HTTP 403: insufficient balance.");

    // The stale 403 must not quarantine the rebuilt record, so A still wins.
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("quarantines a credential on its first auth or balance failure", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    // One 403 is a self-describing verdict: A cools for 30 minutes at once —
    // an 11-failure window burned eleven doomed requests per dead credential.
    state.recordResult(
      selectAndReserve(state, config, { model: "gpt-5.5" }),
      403,
      "Upstream returned HTTP 403: insufficient balance."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");

    state.recordResult(
      selectAndReserve(state, config, { model: "gpt-5.5" }),
      401,
      "Upstream returned HTTP 401: invalid token."
    );

    // Both are quarantined now; the fallback prefers A because it started
    // cooling first and so unblocks sooner.
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

    recordRequests(state, config, 1, 401, "Upstream returned HTTP 401: invalid token.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");

    const rotatedConfig = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "good-key"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "fallback-key")
    ]);

    expect(state.preview(rotatedConfig, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("resets primary health when a profile reasoning effort changes", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a", "xhigh"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b", "low")
    ]);
    const { state } = createState();

    recordModelRequests(
      state,
      config,
      "gpt-5.5",
      11,
      400,
      "Upstream returned HTTP 400: model gpt-5.5 is unsupported for xhigh reasoning."
    );
    const before = state.preview(config, { model: "gpt-5.5" });
    expect(before.profileId).toBe("codex-b");

    const updatedConfig = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a", "low"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "key-b", "low")
    ]);

    const after = state.preview(updatedConfig, { model: "gpt-5.5" });
    expect(after.profileId).toBe("codex-a");
    expect(after.generation).toBe(before.generation + 1);
  });

  it("ignores completions recorded against a stale primary generation", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a", "xhigh")
    ]);
    const state = new PrimaryFailoverState({ random: () => 0 });
    const oldSelection = selectAndReserve(state, config, { model: "gpt-5.5" });
    const updatedConfig = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "key-a", "low")
    ]);
    const currentSelection = selectAndReserve(state, updatedConfig, { model: "gpt-5.5" });

    expect(currentSelection.generation).toBe(oldSelection.generation + 1);

    state.recordResult(oldSelection, {
      status: 200,
      errorSummary: null,
      responseId: "resp-stale"
    });
    expect(state.boundProfileId({ previousResponseId: "resp-stale" })).toBeNull();

    state.recordResult(currentSelection, {
      status: 200,
      errorSummary: null,
      responseId: "resp-current"
    });
    expect(state.boundProfileId({ previousResponseId: "resp-current" })).toBe("codex-a");
  });

  it("preserves primary health when only the active profile rotates", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1", "bad-key"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1", "fallback-key")
    ]);
    const { state } = createState();

    recordRequests(state, config, 1, 401, "Upstream returned HTTP 401: invalid token.");
    const quarantined = state.preview(config, { model: "gpt-5.5" });
    expect(quarantined.profileId).toBe("codex-b");

    const rotatedConfig = cloneConfig(config);
    if (!rotatedConfig.profile_scopes?.codex) {
      throw new Error("Expected Codex profile scope.");
    }
    rotatedConfig.profile_scopes.codex.active_profile_id = "codex-b";

    const rotated = state.preview(rotatedConfig, { model: "gpt-5.5" });
    expect(rotated.profileId).toBe("codex-b");
    expect(rotated.generation).toBe(quarantined.generation);
  });

  it("starts from the active profile and then falls forward through saved order", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1"),
      codexProfile("codex-c", "Codex C", "http://127.0.0.1:9103/v1")
    ], "codex-b");
    const { state } = createState();

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    recordRequests(state, config, 1, 403, "Upstream returned HTTP 403: insufficient balance.");

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-c");
  });

  it("honors Retry-After for rate limits and returns after cooldown expires", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    // Every 429 cools the credential for retry-after — no failure window first.
    clock.state.recordResult(
      selectAndReserve(clock.state, config, { model: "gpt-5.5" }),
      {
        status: 429,
        errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
        responseHeaders: { "retry-after": "2" }
      }
    );

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

    clock.state.recordResult(
      selectAndReserve(clock.state, config, { model: "gpt-5.5" }),
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
      selectAndReserve(state, config, { model: "gpt-missing" }),
      404,
      "Upstream returned HTTP 404: model gpt-missing not found."
    );

    expect(state.preview(config, { model: "gpt-missing" }).profileId).toBe("codex-b");
    expect(state.preview(config, { model: "gpt-available" }).profileId).toBe("codex-a");
  });

  it("never disables on 429 — repeated quotas cool, then the key is reused", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    // Three separate 429s with Retry-After: 2s each. Each one cools A for 2s
    // and B absorbs the next — nobody is *disabled*, so when A's cooldown
    // expires the very next request lands back on it.
    for (let index = 0; index < 3; index += 1) {
      clock.state.recordResult(
        selectAndReserve(clock.state, config, { model: "gpt-5.5" }),
        {
          status: 429,
          errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
          responseHeaders: { "retry-after": "2" }
        }
      );
      clock.advance(2_001);
      expect(clock.state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
      clock.state.recordResult(selectAndReserve(clock.state, config, { model: "gpt-5.5" }), 200, null);
    }
  });

  it("lets a spread pool's fourth key win the weighted pick", () => {
    // The top-K draw used to be capped at three, so a pool sharing one order
    // starved every key past the third. With the window widened, five siblings
    // are all in the draw and each wins its share of the rolls.
    const config = configWithCodexProfiles([
      pooledProfile("codex-a", "A", ["k0", "k1", "k2", "k3", "k4"])
    ]);
    const hits = new Map<string, number>();
    for (let index = 0; index < 5_000; index += 1) {
      // A fresh state per draw keeps all five keys identical; the roll walks
      // evenly across [0, 1) — note the winning band for the last key is the
      // top roll, so the sweep has to reach (total-1, total), not just the
      // integer steps.
      const state = new PrimaryFailoverState({ random: () => (index % 101) / 101 });
      const selection = state.preview(config, { model: "gpt-5.5" });
      hits.set(selection.keyId ?? "", (hits.get(selection.keyId ?? "") ?? 0) + 1);
    }

    expect(hits.get("k4") ?? 0).toBeGreaterThan(0);
    expect(hits.get("k3") ?? 0).toBeGreaterThan(0);
  });

  it("never lets jitter beat a real cooldown deadline", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();
    // A is quarantined for the 30 minute deadline; B for the 60s fallback. The
    // 2s jitter must never flip that order, or flood-back would hammer a key
    // that is still cooling.
    recordRequests(state, config, 1, 401, "Upstream returned HTTP 401: invalid token.");
    recordRequests(state, config, 1, 429, "Upstream returned HTTP 429: slow down.");

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
  });

  it("ignores request-shape errors for profile health", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    state.recordResult(
      selectAndReserve(state, config, { model: "gpt-5.5" }),
      400,
      "Upstream returned HTTP 400: input is required."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("keeps session traffic sticky while the profile remains healthy", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const clock = createState(1_000);

    recordRateLimitFailures(clock.state, config);

    const selection = selectAndReserve(clock.state, config, {
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

    const selection = selectAndReserve(clock.state, config, { model: "gpt-5.5" });
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

    const selection = selectAndReserve(clock.state, config, { model: "gpt-5.5" });
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

    const selection = selectAndReserve(clock.state, config, compactionContext);
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
      const selection = selectAndReserve(clock.state, config, { model: "gpt-5.5", sessionKey });
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
      const selection = selectAndReserve(continuationClock.state, config, { model: "gpt-5.5" });
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
      const selection = selectAndReserve(compactionClock.state, config, { model: "gpt-5.5", compactionStateKey });
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

    recordRequests(state, config, 1, 403, "Upstream returned HTTP 403: insufficient balance.");

    for (const model of ["missing-0", "missing-1", "missing-2"]) {
      for (let index = 0; index < 11; index += 1) {
        const selection = selectAndReserve(state, config, { model });
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
  });

  it("prefers the profile that unblocks soonest when every candidate is blocked", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    // A is quarantined for 30 minutes on its first bad credential response.
    recordRequests(state, config, 1, 401, "Upstream returned HTTP 401: invalid token.");
    // B is rate limited for the minute of the fallback backoff (no Retry-After).
    recordRequests(state, config, 1, 429, "Upstream returned HTTP 429: slow down.");

    // Both are ineligible now, so the fallback ordering decides. A's health score
    // is higher (it is the active profile, order 0), but it stays blocked for
    // half an hour while B recovers almost immediately.
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
  });

  it("lifts a quarantine and a model cooldown once the profile succeeds again", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    recordRequests(state, config, 1, 403, "Upstream returned HTTP 403: insufficient balance.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");

    // The operator tops the account up and applies profile A, which forces one
    // request onto it. That request succeeds, which is proof it works again.
    state.forceNextProfileSelection(config, "codex-a");
    const forced = selectAndReserve(state, config, { model: "gpt-5.5" });
    expect(forced.profileId).toBe("codex-a");
    state.recordResult(forced, 200, null);

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("lifts only the succeeding model's cooldown, not every model's", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    recordModelRequests(state, config, "gone-1", 11, 404, "Upstream returned HTTP 404: model gone-1 not found.");
    recordModelRequests(state, config, "gone-2", 11, 404, "Upstream returned HTTP 404: model gone-2 not found.");
    expect(state.preview(config, { model: "gone-1" }).profileId).toBe("codex-b");
    expect(state.preview(config, { model: "gone-2" }).profileId).toBe("codex-b");

    state.forceNextProfileSelection(config, "codex-a");
    const forced = selectAndReserve(state, config, { model: "gone-1" });
    state.recordResult(forced, 200, null);

    expect(state.preview(config, { model: "gone-1" }).profileId).toBe("codex-a");
    expect(state.preview(config, { model: "gone-2" }).profileId).toBe("codex-b");
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

  it("prefers Codex client metadata and supports zstd request bodies", () => {
    const context = primaryRouteRequestContextFromBody(
      zstdCompressSync(Buffer.from(JSON.stringify({
        model: "gpt-5.6",
        client_metadata: {
          thread_id: "codex-thread",
          session_id: "codex-session"
        }
      }))),
      {
        "thread-id": "header-thread",
        "session-id": "header-session"
      },
      "/responses"
    );

    expect(context).toMatchObject({
      model: "gpt-5.6",
      sessionKey: "codex-thread"
    });
  });

  it("uses Codex thread-id and session-id compatibility headers", () => {
    expect(primaryRouteRequestContextFromBody(
      Buffer.from(JSON.stringify({ model: "gpt-5.6" })),
      { "thread-id": "header-thread", "session-id": "header-session" }
    ).sessionKey).toBe("header-thread");
  });
});

function selectAndReserve(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  context: PrimaryRouteRequestContext
) {
  const selection = state.preview(config, context);
  state.reserveSelection(selection, config.primary_failover.auto_schedule);
  return selection;
}

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
    state.recordResult(selectAndReserve(state, config, { model: "gpt-5.5" }), status, errorSummary);
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
    state.recordResult(selectAndReserve(state, config, { model }), status, errorSummary);
  }
}

function recordRateLimitFailures(
  state: PrimaryFailoverState,
  config: CompactGateConfig,
  count = 1
): void {
  for (let index = 0; index < count; index += 1) {
    state.recordResult(
      selectAndReserve(state, config, { model: "gpt-5.5" }),
      {
        status: 429,
        errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
        responseHeaders: { "retry-after": "2" }
      }
    );
  }
}

function pooledProfile(id: string, name: string, keyIds: string[]): SavedConfigProfile {
  const profile = codexProfile(id, name, "http://127.0.0.1:9101/v1");
  if (!("primary" in profile.config)) {
    throw new Error("Expected Codex profile primary config.");
  }
  profile.config.primary.key_strategy = "spread";
  profile.config.primary.api_keys = keyIds.map((keyId) => ({
    id: keyId,
    label: "",
    api_key: `sk-${keyId}`,
    enabled: true
  }));
  return profile;
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
  primaryApiKey = DEFAULT_CONFIG.primary.api_key,
  reasoningEffort: PrimaryReasoningEffort = DEFAULT_CONFIG.primary.reasoning_effort
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
        api_key: primaryApiKey,
        reasoning_effort: reasoningEffort
      },
      compact: { ...DEFAULT_CONFIG.compact }
    }
  };
}

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}
