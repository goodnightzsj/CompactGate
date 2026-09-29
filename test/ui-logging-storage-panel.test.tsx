import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyForm } from "../src/ui/config/config-form-state.js";
import { LoggingStoragePanel } from "../src/ui/config/LoggingStoragePanel.js";
import type { ConfigFormState } from "../src/ui/config/types.js";

describe("LoggingStoragePanel", () => {
  it("explains inactive capture limits without discarding their draft values", () => {
    const markup = renderToStaticMarkup(<LoggingStoragePanel
      form={{ ...emptyForm(), loggingCaptureDir: "", loggingPersistBody: false, loggingCaptureBodyMaxMiB: 12 }}
      onFormChange={() => undefined} />);
    expect(markup).toContain("当前草稿未启用抓包");
    expect(markup).toContain("环境变量可覆盖");
    expect(markup).toContain('aria-describedby="logging-capture-scope"');
    expect(markup).toContain('value="12"');
  });
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
    const directoryInput = markup.match(/<input[^>]*id="logging-capture-dir"[^>]*>/)?.[0];
    expect(directoryInput).toBeDefined();
    expect(directoryInput).not.toContain("disabled");
  });
});
