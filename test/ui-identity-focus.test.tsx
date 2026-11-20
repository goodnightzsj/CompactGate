// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ClientIdentityStore } from "../src/server/client-identity-store.js";
import { ClientIdentityPanel } from "../src/ui/routes/ClientIdentityPanel.js";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it.each(["escape", "cancel", "save"] as const)("returns focus to the same UA editor after %s", async action => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const status = new ClientIdentityStore({ statePath: "unused" }).status();
  const submit = vi.fn(async () => Response.json(status));
  vi.stubGlobal("fetch", submit);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ClientIdentityPanel status={status} onStatusChange={vi.fn()} />));
    expect(document.activeElement).toBe(document.body);
    const source = container.querySelectorAll(".identity-source")[2];
    const edit = () => source.querySelector<HTMLButtonElement>(".identity-source-actions button")!;
    await act(async () => edit().click());
    const input = source.querySelector("input.identity-source-input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      if (action === "cancel") source.querySelector<HTMLButtonElement>(".identity-source-actions button:last-child")!.click();
      else input.dispatchEvent(new KeyboardEvent("keydown", { key: action === "save" ? "Enter" : "Escape", bubbles: true }));
    });
    expect(source.querySelector(".identity-source-input")).toBeNull();
    expect(document.activeElement).toBe(edit());
    expect(submit).toHaveBeenCalledTimes(action === "save" ? 1 : 0);
  } finally { await act(async () => root.unmount()); }
});

it.each([false, true])("restores focus after a slow save only when the user stayed in the editor, moved=%s", async moved => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const status = new ClientIdentityStore({ statePath: "unused" }).status();
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><ClientIdentityPanel status={status} onStatusChange={vi.fn()} /><input aria-label="route preview path" /></>));
    const source = host.querySelectorAll(".identity-source")[2];
    await act(async () => source.querySelector<HTMLButtonElement>(".identity-source-actions button")!.click());
    const input = source.querySelector<HTMLInputElement>(".identity-source-input")!;
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const otherField = host.querySelector<HTMLInputElement>('input[aria-label="route preview path"]')!;
    // A browser may blur a focused input when the save disables it.
    await act(async () => moved ? otherField.focus() : input.blur());
    await act(async () => resolve(Response.json(status)));
    expect(document.activeElement).toBe(moved ? otherField : source.querySelector(".identity-source-actions button"));
  } finally { await act(async () => root.unmount()); }
});
