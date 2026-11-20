// @vitest-environment jsdom
import path from "node:path";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { ConfigPage } from "../src/ui/config/ConfigPage.js";
import type { ConfigTab } from "../src/ui/config/types.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { useStudioBootstrap } from "../src/ui/hooks/useStudioBootstrap.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

let root: Root | undefined;
let store: ConfigStore | undefined;
let state: ReturnType<typeof useStudioBootstrap>;

function Harness({ tab }: { tab: ConfigTab }) {
  state = useStudioBootstrap("config");
  const actions = useConfigActions({ ...state, linkedCompactModel: "synthetic", refreshHealthAfterWrite: async () => {} });
  return <ConfigPage config={state.config} actions={actions} form={state.form} configTab={tab}
    displayScope="codex" onDisplayScopeChange={() => {}} hasPendingChanges={false}
    linkedCompactModel="synthetic" onFormChange={state.setForm} onConfigTabChange={() => {}} />;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  store?.oauth.close();
  store = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const editors = [
  { tab: "model", selector: "#primary-model-override", field: "primaryModelOverride", draft: "operator-draft" },
  { tab: "routes", selector: '[aria-label="基础地址"]', field: "codexPrimaryBaseUrl", draft: "https://draft.synthetic.invalid/v1" },
  { tab: "logging", selector: "#logging-keep-recent", field: "loggingKeepRecent", draft: 117 }
] as const;

for (const editor of editors) {
  it.each(["initial-load", "retry-after-failure", "refresh-after-loaded"] as const)(
    `${editor.tab} accepts drafts only after a baseline during %s`, async phase => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
      await store.patch({ primary: { model_override: "saved-model" } });
      const saved = store.toPublicConfig();
      let resolve!: (response: Response) => void;
      const pending = new Promise<Response>(done => { resolve = done; });
      let reading = phase === "initial-load";
      const fetcher = vi.fn(async (url: string) => {
        if (url === "/api/health") return Response.json({ time: "synthetic" });
        if (url === "/api/oauth/accounts") return Response.json({ accounts: [] });
        if (url === "/api/config") {
          if (reading) return pending.then(response => response.clone());
          return phase === "retry-after-failure"
            ? Response.json({ error: "Synthetic load failed" }, { status: 503 }) : Response.json(saved);
        }
        throw new Error(`Unexpected synthetic request: ${url}`);
      });
      vi.stubGlobal("fetch", fetcher);
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () => root!.render(<StrictMode><Harness tab={editor.tab} /></StrictMode>));
      if (phase !== "initial-load") {
        if (phase === "retry-after-failure") expect(state.pageError).toContain("Synthetic load failed");
        reading = true;
        await act(async () => state.retryBootstrap());
      }
      const panel = host.querySelector('[role="tabpanel"]')!;
      if (phase === "refresh-after-loaded") {
        const input = panel.querySelector<HTMLInputElement>(editor.selector)!;
        expect(input.disabled).toBe(false);
        expect(input.readOnly).toBe(false);
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(editor.draft));
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(state.form[editor.field]).toBe(editor.draft);
      } else {
        expect(panel.querySelector("input, select, textarea, button")).toBeNull();
        expect(panel.querySelector('[role="status"]')?.textContent).toContain("加载成功后即可编辑");
        expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5);
      }
      await act(async () => resolve(Response.json(saved)));
      expect(state.config?.primary.model_override).toBe("saved-model");
      const input = panel.querySelector<HTMLInputElement>(editor.selector)!;
      expect(input).not.toBeNull();
      expect(input.disabled).toBe(false);
      if (phase === "refresh-after-loaded") {
        expect(input.value).toBe(String(editor.draft));
        expect(state.form[editor.field]).toBe(editor.draft);
      } else {
        expect(state.form.primaryModelOverride).toBe("saved-model");
        expect(panel.textContent).not.toContain("加载成功后即可编辑");
      }
    }
  );
}
