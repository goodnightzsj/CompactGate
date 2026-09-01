import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import type { ConfigFormState } from "../src/ui/config/types.js";

describe("RouteConfigPanel", () => {
  it("shows one controlled upstream protocol selector for every route", () => {
    const form = emptyForm();
    const setForm: Dispatch<SetStateAction<ConfigFormState>> = () => undefined;
    const markup = renderToStaticMarkup(
      <RouteConfigPanel config={null} form={form} onFormChange={setForm} />
    );

    expect(markup).toContain("Codex 主路由 上游格式");
    expect(markup).toContain("Codex 压缩路由 上游格式");
    expect(markup).toContain("Claude 主路由 上游格式");
    expect(markup).toContain("Claude 压缩路由 上游格式");
    expect(markup).toContain("Claude 压缩上游模式");
    expect(markup.match(/OpenAI Responses/g)).toHaveLength(2);
    expect(markup.match(/Anthropic Messages/g)).toHaveLength(2);
  });
});
