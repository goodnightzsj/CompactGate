import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigPage, type ConfigDisplayScope } from "../src/ui/config/ConfigPage.js";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import { CONFIG_TABS } from "../src/ui/config/config-tabs.js";
import type { ConfigTab } from "../src/ui/config/types.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";

function Page({ tab, scope = "codex" }: { tab: ConfigTab; scope?: ConfigDisplayScope }) {
  const form = emptyForm();
  const noop = () => undefined;
  const actions = useConfigActions({
    config: null, form, linkedCompactModel: "", draftRevision: 0, formRevision: null,
    commitConfig: noop, rebaseFormRevision: noop, applyRemoteConfig: noop,
    applyProfileConfig: noop, setConfig: noop, setForm: noop, setHealth: noop, setPageError: noop
  });
  return <ConfigPage config={null} actions={actions} form={form} configTab={tab}
    displayScope={scope} onDisplayScopeChange={noop} hasPendingChanges={false}
    linkedCompactModel="" onFormChange={noop} onConfigTabChange={noop} />;
}

describe("configuration page context", () => {
  it.each(CONFIG_TABS)("keeps $id navigation and save scope intact", ({ id, title }) => {
    const markup = renderToStaticMarkup(<Page tab={id} />);
    const header = markup.split('class="config-layout"')[0];
    expect(header).toContain(`<h2>${title}</h2>`);
    expect(markup.match(/role="tab"/g)).toHaveLength(5);
    expect(markup).toContain(`id="config-panel-${id}" role="tabpanel" aria-labelledby="config-tab-${id}"`);
    expect(markup).not.toContain("config-scope-heading");
    if (id === "logging" || id === "portable") {
      expect(header).not.toContain('aria-label="配置展示客户端"');
    } else {
      expect(header).toContain('aria-label="配置展示客户端"');
      expect(header).toContain('aria-pressed="true">Codex</button>');
    }
    expect(markup.includes('aria-label="配置保存"')).toBe(id !== "portable");
    if (id !== "portable") expect(markup).toContain("保存范围：全部配置");
  });

  it("resolves the all-profiles view to Codex for connection editing", () => {
    const markup = renderToStaticMarkup(<Page tab="routes" scope="all" />);
    expect(markup).toContain('aria-pressed="true">Codex</button>');
    expect(markup).toContain("Codex 主路由");
    expect(markup).not.toContain("Claude 主路由");
  });
});
