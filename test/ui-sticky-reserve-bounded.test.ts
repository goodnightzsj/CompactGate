import { describe, expect, it } from "vitest";
import {
  applyDraftToConfigExport,
  emptyForm,
  formToPatch
} from "../src/ui/config/config-form-state.js";
import { DEFAULT_CONFIG } from "../src/server/config-defaults.js";
import { validateRuntimeConfig } from "../src/server/config-runtime.js";

// The number input advertises min={0} max={86400} that nothing enforces — there is
// no <form>, so HTML5 constraint validation never runs — and the server rejects the
// whole PATCH on a bad value. One stray digit therefore used to discard every other
// edit in the draft, with an error naming a field the user may have forgotten
// touching. These bounds keep the rest of the save.
describe("sticky_reserve_seconds bounds", () => {
  it("clamps above the ceiling instead of failing the whole patch", () => {
    const patch = formToPatch({ ...emptyForm(), codexPrimaryStickyReserveSeconds: 90_000 });
    expect(patch.primary.sticky_reserve_seconds).toBe(86_400);
    // The value the server would have refused now passes its own validation.
    expect(() => validateRuntimeConfig({
      ...DEFAULT_CONFIG,
      primary: { ...DEFAULT_CONFIG.primary, sticky_reserve_seconds: 86_400 }
    })).not.toThrow();
  });

  it("rounds a fractional value the server would have refused", () => {
    const patch = formToPatch({ ...emptyForm(), claudePrimaryStickyReserveSeconds: 1.7 });
    expect(patch.claude.primary.sticky_reserve_seconds).toBe(2);
  });

  it("omits a blank or negative box so the stored value stands", () => {
    // `Number("")` is 0, and 0 disables the sticky zone outright, so a cleared box
    // must not be sent as 0 — that would silently turn the feature off.
    for (const value of [Number.NaN, -1]) {
      const patch = formToPatch({ ...emptyForm(), codexPrimaryStickyReserveSeconds: value });
      expect(patch.primary.sticky_reserve_seconds).toBeUndefined();
    }
  });

  it("still sends an explicit 0, which is a real setting", () => {
    const patch = formToPatch({ ...emptyForm(), codexPrimaryStickyReserveSeconds: 0 });
    expect(patch.primary.sticky_reserve_seconds).toBe(0);
  });

  it("falls back to the stored number on export, which needs a concrete value", () => {
    const stored = { ...DEFAULT_CONFIG.primary, sticky_reserve_seconds: 45 };
    const exported = applyDraftToConfigExport(
      { ...DEFAULT_CONFIG, primary: stored },
      { ...emptyForm(), codexPrimaryStickyReserveSeconds: Number.NaN }
    );
    expect(exported.primary.sticky_reserve_seconds).toBe(45);
    // And an out-of-range draft value is clamped rather than exported as-is.
    expect(applyDraftToConfigExport(
      { ...DEFAULT_CONFIG, primary: stored },
      { ...emptyForm(), codexPrimaryStickyReserveSeconds: 90_000 }
    ).primary.sticky_reserve_seconds).toBe(86_400);
  });
});
