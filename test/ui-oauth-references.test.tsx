// @vitest-environment jsdom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import { OAuthProfilesPanel } from "../src/ui/config/OAuthProfilesPanel.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

afterEach(() => vi.unstubAllGlobals());

it("counts each linked profile once across scopes and locates the right scope without applying it", async () => {
  const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
  await store.saveProfile("codex", "Shared", {});
  await store.saveProfile("claude", "Shared", {});
  const config = store.toPublicConfig();
  const codex = config.profile_scopes.codex.profiles[0], claude = config.profile_scopes.claude.profiles[0];
  codex.oauth_account_id = codex.compact_oauth_account_id = claude.compact_oauth_account_id = "account";
  const fetcher = vi.fn(async () => Response.json({ accounts: [{ id: "account", label: "Fixture", status: "connected", provider: "openrouter" }] }));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const locate = vi.fn(), change = vi.fn();
  // jsdom has dialog elements but does not implement their presentation.
  const create = document.createElement.bind(document);
  const elements = vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = create(tag, options);
    if (element instanceof HTMLDialogElement) {
      element.showModal = () => { element.open = true; };
      element.close = () => { element.open = false; };
    }
    return element;
  });
  try {
    await act(async () => root.render(<OAuthProfilesPanel config={config} onProfileLocate={locate} onConfigChange={change} />));
    expect(host.querySelector(".oauth-account")?.textContent).toContain("2 个档案引用");
    for (const [label, profile] of [["Codex", codex], ["Claude", claude]] as const) {
      const link = host.querySelector<HTMLButtonElement>(`[aria-label="定位 ${label} 档案 Shared"]`)!;
      await act(async () => link.click());
      expect(locate).toHaveBeenLastCalledWith(profile.scope, profile.id);
    }
    await act(async () => host.querySelector<HTMLButtonElement>(".profile-danger-button")!.click());
    expect(host.querySelector("dialog[open]")?.textContent).toContain("2 个档案");
    expect(change).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    elements.mockRestore();
  }
});
