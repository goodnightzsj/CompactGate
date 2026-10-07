import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";

const START = Date.parse("2026-10-07T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(START);
});

afterEach(() => vi.useRealTimers());

describe.each(["primary", "claude"] as const)("%s relative cooldown clock", (route) => {
  it.each([HOUR_MS, -HOUR_MS])("keeps a two-second cooldown across a %i ms wall-clock jump", (jump) => {
    const { select } = createPool(route);
    expect(select("2")).toBe("k1");
    expect(select()).toBe("k2");

    vi.advanceTimersByTime(100);
    vi.setSystemTime(START + 100 + jump);
    // Prove the seam moves only wall time, not the elapsed-time control.
    expect(Date.now()).toBe(START + 100 + jump);
    expect(performance.now()).toBe(100);
    expect(select()).toBe("k2");
    vi.advanceTimersByTime(1_899);
    expect(select()).toBe("k2");
    vi.advanceTimersByTime(1);
    expect(select()).toBe("k1");
  });

  it("converts a future HTTP-date using wall time before counting the delay", () => {
    const { select } = createPool(route);
    expect(select(new Date(START + 2_000).toUTCString())).toBe("k1");
    vi.advanceTimersByTime(1_999);
    expect(select()).toBe("k2");
    vi.advanceTimersByTime(1);
    expect(select()).toBe("k1");
  });

  it("preserves an explicit fixed selection while its key is cooling", () => {
    const { config, select } = createPool(route);
    expect(select("2")).toBe("k1");
    expect(select()).toBe("k2");
    if (route === "primary") config.primary_failover.auto_schedule = false;
    else config.claude.primary.rotation_opt_out = true;
    expect(select()).toBe("k1");
  });

  it("keeps the soonest-to-unblock fallback when no key is healthy", () => {
    const { select } = createPool(route);
    expect(select("2")).toBe("k1");
    expect(select("60")).toBe("k2");
    expect(select()).toBe("k1");
  });
});

function createPool(route: "primary" | "claude") {
  const config = structuredClone(DEFAULT_CONFIG);
  const apiKeys = ["k1", "k2"].map((id) => ({
    id, label: "", api_key: `synthetic-${id}`, enabled: true
  }));
  config.primary.api_key_env = "";
  config.claude.primary.api_key_env = "";
  config.claude.primary.api_keys = apiKeys;
  config.profile_scopes = {
    codex: {
      active_profile_id: "clock-pool",
      profiles: [{
        id: "clock-pool", name: "Clock pool",
        created_at: "2026-10-07T00:00:00.000Z", updated_at: "2026-10-07T00:00:00.000Z",
        config: {
          primary: { ...config.primary, api_keys: apiKeys },
          compact: { ...config.compact }
        }
      }]
    },
    claude: { profiles: [], active_profile_id: null }
  };

  if (route === "primary") {
    const state = new PrimaryFailoverState({ random: () => 0 });
    return {
      config,
      select(retryAfter?: string) {
        const selection = state.preview(config);
        state.reserveSelection(selection, config.primary_failover.auto_schedule);
        state.recordResult(selection, retryAfter === undefined ? null : {
          status: 429, errorSummary: "Synthetic rate limit", responseHeaders: { "retry-after": retryAfter }
        });
        return selection.keyId;
      }
    };
  }

  const state = new ClaudeKeyPoolState({ random: () => 0 });
  return {
    config,
    select(retryAfter?: string) {
      const selection = state.select(config, "clock-pool", {});
      state.recordResult(selection, retryAfter === undefined ? null : {
        status: 429, responseHeaders: { "retry-after": retryAfter }
      });
      return selection?.keyId;
    }
  };
}
