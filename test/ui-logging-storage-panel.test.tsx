import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import { LoggingStoragePanel } from "../src/ui/config/LoggingStoragePanel.js";
import type { ConfigFormState } from "../src/ui/config/types.js";

describe("LoggingStoragePanel", () => {
  it("renders labeled storage controls and an explicit maintenance action", () => {
    const setForm: Dispatch<SetStateAction<ConfigFormState>> = () => undefined;
    const markup = renderToStaticMarkup(
      <LoggingStoragePanel form={emptyForm()} onFormChange={setForm} />
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(3);
    expect(markup).toContain('for="logging-keep-recent"');
    expect(markup).toContain('for="logging-capture-dir"');
    expect(markup).toContain("清理历史正文");
    expect(markup).not.toContain("正文脱敏");
  });
});
