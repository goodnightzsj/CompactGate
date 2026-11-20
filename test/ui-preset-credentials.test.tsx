// @vitest-environment jsdom
import path from "node:path";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import { formFromConfig } from "../src/ui/config/config-form-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

it.each(["codex", "claude"] as const)("keeps explicitly entered %s pool keys while discarding hidden keys on a preset switch", async scope => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  const patch = (primary: unknown) => scope === "codex" ? { primary } : { claude: { primary } };
  await store.patch(patch({ base_url: "http://b.invalid", api_key: "synthetic-B", api_key_env: "" }));
  await store.patch(patch({ base_url: "http://a.invalid", api_key: "synthetic-A", api_key_env: "",
    api_keys: [{ id: "old", api_key: "synthetic-old", enabled: true }] }));
  const config = store.toPublicConfig();
  const prefix = scope === "codex" ? "codexPrimary" : "claudePrimary";
  let observed = formFromConfig(config);
  const explicit = { id: "new", label: "Explicit new key", apiKey: "synthetic-new", enabled: true, priority: 0, tail: "" };
  observed[`${prefix}ApiKeys`].push(explicit);
  function Harness() {
    const [form, setForm] = useState(observed);
    observed = form;
    return <RouteConfigPanel config={config} form={form} onFormChange={setForm} onManageOAuth={() => {}} scope={scope} />;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ accounts: [] })));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    const suggestion = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .find(button => button.textContent?.includes("http://b.invalid"));
    expect(suggestion).toBeDefined();
    await act(async () => suggestion!.click());
    expect(observed[`${prefix}BaseUrl`]).toBe("http://b.invalid");
    expect(observed[`${prefix}CredentialPresetId`]).not.toBe("");
    expect(observed[`${prefix}ApiKeys`]).toEqual([explicit]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
