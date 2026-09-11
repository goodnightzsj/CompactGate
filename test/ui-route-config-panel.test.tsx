import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import type { ConfigFormState } from "../src/ui/config/types.js";

describe("RouteConfigPanel", () => {
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
    expect(markup).toContain(`${client} 压缩路由 上游格式`);
    expect(markup).toContain(`${client} 压缩上游模式`);
    expect(markup).not.toContain(`${otherClient} 主路由`);
    expect(markup.match(scope === "codex" ? /OpenAI Responses/g : /Anthropic Messages/g)).toHaveLength(2);
    expect(markup).toContain(`https://${scope}-compact.example`);
    expect(markup.match(/<details class="route-compact-settings"[^>]*>/)?.[0])
      .toBe(scope === "codex" ? '<details class="route-compact-settings" open="">' : '<details class="route-compact-settings">');
  });
});
