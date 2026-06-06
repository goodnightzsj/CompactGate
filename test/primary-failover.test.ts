import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import {
  classifyPrimaryRouteResult,
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody
} from "../src/server/primary-failover.js";
import type { CompactGateConfig, SavedConfigProfile } from "../src/shared/types.js";

describe("PrimaryFailoverState", () => {
  it("resets empty-stream failure counts after a successful primary stream", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    recordRequests(state, config, 3, 200, "OpenAI stream closed before response.completed.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    state.recordResult(state.select(config, { model: "gpt-5.5" }), 200, null);
    recordRequests(state, config, 3, 200, "OpenAI stream closed before response.completed.");
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");

    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      200,
      "OpenAI stream closed before response.completed."
    );
    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
  });

  it("quarantines auth and balance failures instead of waiting for reconnect threshold", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      403,
      "Upstream returned HTTP 403: insufficient balance."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    expect(state.getHealthSnapshot().find((entry) => entry.profileId === "codex-a")).toMatchObject({
      quarantineUntil: expect.any(Number)
    });

    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
      401,
      "Upstream returned HTTP 401: invalid token."
    );

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-a");
  });

  it("starts from the active profile and then falls forward through saved order", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1"),
      codexProfile("codex-c", "Codex C", "http://127.0.0.1:9103/v1")
    ], "codex-b");
    const { state } = createState();

    expect(state.preview(config, { model: "gpt-5.5" }).profileId).toBe("codex-b");
    state.recordResult(
      state.select(config, { model: "gpt-5.5" }),
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

    clock.state.recordResult(
      clock.state.select(config, { model: "gpt-5.5" }),
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

  it("disables an incompatible model without poisoning the whole profile", () => {
    const config = configWithCodexProfiles([
      codexProfile("codex-a", "Codex A", "http://127.0.0.1:9101/v1"),
      codexProfile("codex-b", "Codex B", "http://127.0.0.1:9102/v1")
    ]);
    const { state } = createState();

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

    clock.state.recordResult(
      clock.state.select(config, { model: "gpt-5.5" }),
      {
        status: 429,
        errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
        responseHeaders: { "retry-after": "2" }
      }
    );

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

    clock.state.recordResult(
      clock.state.select(config, { model: "gpt-5.5" }),
      {
        status: 429,
        errorSummary: "Upstream returned HTTP 429: rate limit exceeded.",
        responseHeaders: { "retry-after": "2" }
      }
    );

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
  });
});

describe("primaryRouteRequestContextFromBody", () => {
  it("extracts model, previous response id, and session key from body and headers", () => {
    expect(primaryRouteRequestContextFromBody(
      Buffer.from(JSON.stringify({
        model: "gpt-5.5",
        previous_response_id: "resp-old",
        metadata: { session_hash: "body-session" }
      })),
      { "x-session-id": "header-session" },
      "/responses"
    )).toEqual({
      endpoint: "/responses",
      model: "gpt-5.5",
      previousResponseId: "resp-old",
      sessionKey: "body-session"
    });
  });
});

function createState(startNow = 0): {
  state: PrimaryFailoverState;
  advance: (ms: number) => void;
} {
  let now = startNow;
  return {
    state: new PrimaryFailoverState({
      now: () => now,
      random: () => 0
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

function codexProfile(id: string, name: string, primaryBaseUrl: string): SavedConfigProfile {
  return {
    id,
    name,
    created_at: "2026-06-06T00:00:00.000Z",
    updated_at: "2026-06-06T00:00:00.000Z",
    config: {
      primary: {
        ...DEFAULT_CONFIG.primary,
        base_url: primaryBaseUrl
      },
      compact: { ...DEFAULT_CONFIG.compact }
    }
  };
}

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}
