// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApiKeyPoolEditor } from "../src/ui/config/ApiKeyPoolEditor.js";
import { emptyForm, formToPatch } from "../src/ui/config/config-form-state.js";

it("keeps an empty sticky reserve distinct from an explicit zero for both clients", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let observed = 45;
  function Harness() {
    const [reserve, setReserve] = useState(45);
    observed = reserve;
    return <ApiKeyPoolEditor title="Synthetic" direct={{ configured: false, tail: "", priority: 0 }}
      entries={[]} strategy="fill_first" rotationEnabled rotationOptOut={false}
      stickyReserveSeconds={reserve} onStickyReserveChange={setReserve}
      onEntriesChange={() => undefined} onDirectPriorityChange={() => undefined}
      onStrategyChange={() => undefined} onRotationOptOutChange={() => undefined} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
    for (const value of ["", "0", "60"]) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(input.value).toBe(value);
      const patch = JSON.parse(JSON.stringify(formToPatch({ ...emptyForm(), codexPrimaryStickyReserveSeconds: observed, claudePrimaryStickyReserveSeconds: observed })));
      for (const route of [patch.primary, patch.claude.primary]) {
        if (value === "") expect(route).not.toHaveProperty("sticky_reserve_seconds");
        else expect(route.sticky_reserve_seconds).toBe(Number(value));
      }
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
