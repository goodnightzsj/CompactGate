import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import type { ConfigFormState } from "../src/ui/config/types.js";

describe("RouteConfigPanel", () => {
  it.each(["codex", "claude"] as const)("shows %s keys in priority order and marks inactive entries without counting them", (scope) => {
    const form = emptyForm();
    const prefix = scope === "codex" ? "codexPrimary" : "claudePrimary";
    const client = scope === "codex" ? "Codex" : "Claude";
    form[`${prefix}ApiKey`] = "sk-synthetic-direct";
    form[`${prefix}ApiKeyPriority`] = 10;
    form[`${prefix}ApiKeys`] = [
      { id: "backup", label: "Backup", priority: 0, apiKey: "", tail: "back", enabled: true },
      { id: "first", label: "Preferred", priority: 70, apiKey: "", tail: "pref", enabled: true },
      { id: "off", label: "Disabled", priority: 100, apiKey: "", tail: "stop", enabled: false },
      { id: "blank", label: "Missing", priority: 90, apiKey: "", tail: "", enabled: true }
    ];
    const markup = renderToStaticMarkup(<RouteConfigPanel config={null} form={form} onFormChange={() => {}} onManageOAuth={() => {}} scope={scope} />);
    expect(markup).toContain(`aria-label="${client} 主路由 密钥使用顺序"`);
    expect(markup).toContain(`aria-label="${client} 主路由 直填密钥优先级"`);
    expect(markup).toContain("草稿 · 保存后生效");
    const reserveId = markup.match(/<label for="([^"]+)">粘性保留时长（秒）<\/label>/)?.[1];
    expect(reserveId).toBeTruthy();
    expect(markup).toContain(`id="${reserveId}" aria-describedby="${reserveId}-hint"`);
    expect(markup).toContain(`id="${reserveId}-hint">429 冷却结束后只接原会话的时长；0 关闭。`);
    expect(markup).toContain("首选不代表正在使用");
    expect(markup).toContain("3 把候选");
    expect(markup.match(/data-key-id="([^"]+)"/g)).toEqual([
      'data-key-id="off"', 'data-key-id="blank"', 'data-key-id="first"', 'data-key-id="__direct__"', 'data-key-id="backup"'
    ]);
    const labels = markup.match(/class="key-pool-label-input"[^>]+/g) ?? [];
    expect(labels[0]).toContain('value="Disabled"');
    expect(labels[2]).toContain('value="Preferred"');
    expect(form[`${prefix}ApiKeys`].map((entry) => entry.id)).toEqual(["backup", "first", "off", "blank"]);
    expect(markup).toContain('aria-label="置顶 Preferred"');
    expect(markup).toContain('min="0" max="100" step="1"');
  });

  it.each(["codex", "claude"] as const)("shows only the %s connection settings and keeps its compact draft", (scope) => {
    const form = emptyForm();
    form.codexCompactBaseUrl = "https://codex-compact.example/v1";
    form.claudeCompactBaseUrl = "https://claude-compact.example";
    const setForm: Dispatch<SetStateAction<ConfigFormState>> = () => undefined;
    const markup = renderToStaticMarkup(
      <RouteConfigPanel config={null} form={form} onFormChange={setForm} onManageOAuth={() => {}} scope={scope} />
    );

    const client = scope === "codex" ? "Codex" : "Claude";
    const otherClient = scope === "codex" ? "Claude" : "Codex";
    expect(markup).toContain(`${client} 主路由 上游格式`);
    expect(markup).not.toContain(`${otherClient} 主路由`);
    if (scope === "codex") {
      expect(markup).toContain("Codex 压缩路由 上游格式");
      expect(markup).toContain("Codex 压缩上游模式");
      expect(markup).toContain("https://codex-compact.example");
      expect(markup).toContain('<details class="route-compact-settings" open="">');
    } else {
      expect(markup).not.toContain("Claude 压缩路由");
      expect(markup).not.toContain("Claude 压缩上游模式");
      expect(markup).not.toContain("https://claude-compact.example");
      expect(markup).toContain("统一使用 Claude 主路由");
      expect(markup).toContain("旧备份中的独立压缩字段仍会保留");
    }
    expect(form.claudeCompactBaseUrl).toBe("https://claude-compact.example");
  });
});
