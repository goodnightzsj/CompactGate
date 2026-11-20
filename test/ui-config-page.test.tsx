import { renderToStaticMarkup } from "react-dom/server";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config.js";
import type { PublicConfig } from "../src/shared/types.js";
import { ConfigPage, type ConfigDisplayScope } from "../src/ui/config/ConfigPage.js";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import { CONFIG_TABS } from "../src/ui/config/config-tabs.js";
import type { ConfigTab } from "../src/ui/config/types.js";
import { useConfigActions } from "../src/ui/hooks/useConfigActions.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";

function Page({ tab, scope = "codex", config = null }: { tab: ConfigTab; scope?: ConfigDisplayScope; config?: PublicConfig | null }) {
  const form = emptyForm();
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  const actions = useConfigActions({
    config, form, linkedCompactModel: "", draftRevision: 0, formRevision: null, formBaseline: null,
    commitConfig: asyncNoop, applyWrittenConfig: asyncNoop,
    applyProfileConfig: asyncNoop, setConfig: asyncNoop, setForm: noop, refreshHealthAfterWrite: asyncNoop
  });
  return <ConfigPage config={config} actions={actions} form={form} configTab={tab}
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

  it("resolves the all-profiles view to Codex for connection editing", async () => {
    const store = await ConfigStore.load(path.join(await makeConfigDir(), "compactgate.json"));
    try {
      const markup = renderToStaticMarkup(<Page tab="routes" scope="all" config={store.toPublicConfig()} />);
      expect(markup).toContain('aria-pressed="true">Codex</button>');
      expect(markup).toContain("Codex 主路由");
      expect(markup).not.toContain("Claude 主路由");
    } finally { store.oauth.close(); }
  });

  it.each(["routes", "model"] as const)("waits for a Claude baseline before rendering %s draft fields", tab => {
    const markup = renderToStaticMarkup(<Page tab={tab} scope="claude" />);
    expect(markup).toContain("加载成功后即可编辑");
    expect(markup).not.toContain("<input");
  });

  it("keeps recovery entry points available without a configuration baseline", () => {
    const profiles = renderToStaticMarkup(<Page tab="profiles" />);
    expect(profiles).toContain("添加授权连接");
    const portable = renderToStaticMarkup(<Page tab="portable" />);
    expect(portable).toContain('type="file"');
    expect(portable).not.toContain("加载成功后即可编辑");
  });
});
