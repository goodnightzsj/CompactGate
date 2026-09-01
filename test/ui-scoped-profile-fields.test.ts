import { describe, expect, it } from "vitest";
import {
  formAfterScopedProfileChange,
  formFromConfig,
  formToPatch,
  isFormDirty
} from "../src/ui/config/config-form-state.js";
import { buildPublicConfig } from "../src/server/config-public.js";
import { mergeRuntimeConfig } from "../src/server/config-runtime.js";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import type { CompactGateConfig } from "../src/shared/types.js";

// A profile stores its whole route object, key pool included, so activating one has
// to re-adopt that pool into the draft. While it did not, the draft kept the
// *previous* profile's rows: the editor rendered them, the dirty check compared
// their tails and never matched, and the next plain save forwarded their ids with
// no secret. `mergeApiKeys` resolves plaintext by id, so unknown ids collapse to ""
// and the activated profile's real credentials are replaced by empty entries.
const ACTIVATED: CompactGateConfig = mergeRuntimeConfig(DEFAULT_CONFIG, {
  primary: {
    base_url: "https://b.example/v1",
    key_strategy: "spread",
    rotation_opt_out: true,
    sticky_reserve_seconds: 45,
    api_keys: [
      { id: "B-1", label: "b one", api_key: "sk-REAL-B1", enabled: true },
      { id: "B-2", label: "b two", api_key: "sk-REAL-B2", enabled: true }
    ]
  }
}) as CompactGateConfig;

const PUBLIC_ACTIVATED = buildPublicConfig({
  config: ACTIVATED,
  configPath: "/tmp/compactgate.json",
  lastSavedAt: null,
  revision: "r1"
});

// What the draft looks like right after a switch, before the fix re-adopted: one
// row belonging to whichever profile was open before. Everything else matches the
// activated config so the assertions isolate the pool — a draft built from
// `emptyForm()` would differ in logging and Claude fields the switch never touches,
// and would read dirty for reasons that have nothing to do with this bug.
const STALE_DRAFT = {
  ...formFromConfig(PUBLIC_ACTIVATED),
  codexPrimaryApiKeys: [
    { id: "A-1", label: "a one", tail: "aaaa", apiKey: "", enabled: true }
  ],
  codexPrimaryKeyStrategy: "fill_first" as const,
  codexPrimaryRotationOptOut: false,
  codexPrimaryStickyReserveSeconds: 0
};

describe("scoped profile form fields", () => {
  it("re-adopts the activated profile's key pool instead of keeping the old one", () => {
    const next = formAfterScopedProfileChange(STALE_DRAFT, PUBLIC_ACTIVATED, "codex");

    expect(next.codexPrimaryApiKeys.map((entry) => entry.id)).toEqual(["B-1", "B-2"]);
    expect(next.codexPrimaryKeyStrategy).toBe("spread");
    expect(next.codexPrimaryRotationOptOut).toBe(true);
    expect(next.codexPrimaryStickyReserveSeconds).toBe(45);
    // The save bar has to settle: a draft that just adopted the profile is clean.
    expect(isFormDirty(PUBLIC_ACTIVATED, next)).toBe(false);
  });

  it("no longer empties the activated profile's secrets on the next plain save", () => {
    const patch = formToPatch(formAfterScopedProfileChange(STALE_DRAFT, PUBLIC_ACTIVATED, "codex"));
    const saved = mergeRuntimeConfig(ACTIVATED, patch);

    expect(saved.primary.api_keys?.map((entry) => entry.api_key))
      .toEqual(["sk-REAL-B1", "sk-REAL-B2"]);
  });
});
