// @vitest-environment jsdom
import path from "node:path";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { resolveRouteCredential } from "../src/server/credentials.js";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import { applyDraftToConfigExport, formFromConfig, formToPatch } from "../src/ui/config/config-form-state.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each((["primary", "compact", "claude_primary"] as const).flatMap(kind =>
  ["keep", "clear", "undo", "replace", "replace-clear", "empty-env"].map(edit => ({ kind, edit }))))(
  "preserves the selected preset credential when editing $kind ($edit)", async ({ kind, edit }) => {
    vi.stubEnv("PRESET_OLD_KEY", "synthetic-old-secret");
    vi.stubEnv("PRESET_NEW_KEY", "synthetic-new-secret");
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "config.json"));
    const routePatch = (value: unknown) => kind === "claude_primary" ? { claude: { primary: value } } : { [kind]: value };
    await store.patch(routePatch({ base_url: "http://selected.invalid/v1", api_key: "synthetic-new-direct",
      api_key_env: edit === "empty-env" ? "" : "PRESET_NEW_KEY" }));
    await store.patch(routePatch({ base_url: "http://old.invalid/v1", api_key: "synthetic-old-direct", api_key_env: "PRESET_OLD_KEY" }));
    const config = store.toPublicConfig();
    let observed = formFromConfig(config);
    const scope = kind === "claude_primary" ? "claude" : "codex";
    const title = kind === "primary" ? "Codex 主路由" : kind === "compact" ? "Codex 压缩路由" : "Claude 主路由";
    function Harness() {
      const [form, setForm] = useState(observed);
      observed = form;
      return <RouteConfigPanel config={config} form={form} onFormChange={setForm} onManageOAuth={() => {}} scope={scope} />;
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ accounts: [] })));
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<Harness />));
      const section = host.querySelector<HTMLElement>(`section[aria-label="${title}"]`)!;
      await act(async () => section.querySelector<HTMLInputElement>('input[role="combobox"]')!.focus());
      const suggestion = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
        .find(button => button.textContent?.includes("http://selected.invalid/v1"))!;
      await act(async () => suggestion.click());
      if (edit.startsWith("replace")) await act(async () => {
        const key = section.querySelector<HTMLInputElement>('input[type="password"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key, "synthetic-replacement");
        key.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const clear = [...section.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "清空已保存密钥")!;
      if (["clear", "undo", "replace-clear", "empty-env"].includes(edit)) await act(async () => clear.click());
      if (edit === "undo") await act(async () => clear.click());
      const exported = applyDraftToConfigExport(store.get(), observed);
      await store.patch(JSON.parse(JSON.stringify(formToPatch(observed))));
      const expected = edit === "empty-env" ? null : edit === "replace" ? "synthetic-replacement"
        : ["clear", "replace-clear"].includes(edit) ? "synthetic-new-secret" : "synthetic-new-direct";
      expect(resolveRouteCredential(kind, store.get()).apiKey).toBe(expected);
      expect(resolveRouteCredential(kind, exported).apiKey).toBe(expected);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      store.oauth.close();
    }
  }
);
