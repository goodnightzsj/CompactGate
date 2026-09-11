import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigPreviewPanel } from "../src/ui/config/ConfigPreviewPanel.js";

describe("ConfigPreviewPanel", () => {
  it("labels inputs, distinguishes saved configuration and exposes pending state", () => {
    const markup = renderToStaticMarkup(<ConfigPreviewPanel
      isPreviewing
      previewPath="/v1/responses"
      previewBody="{}"
      previewHeaders="{}"
      preview={null}
      previewError={null}
      onPathChange={() => undefined}
      onBodyChange={() => undefined}
      onHeadersChange={() => undefined}
      onPreviewSubmit={() => undefined}
      onPreviewClear={() => undefined}
    />);
    expect(markup).toContain('for="preview-body"');
    expect(markup).toContain('for="preview-headers"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatch(/disabled=""[^>]*>试算中/);
    expect(markup).toContain("取消试算");
    expect(markup).toContain('<form class="config-preview-inputs">');
    expect(markup).toContain('type="submit"');
    expect(markup).toContain("基于已保存的配置，不包含未保存草稿。");
  });

  it("keeps request headers mounted and exposes them when a preview fails", () => {
    const markup = renderToStaticMarkup(<ConfigPreviewPanel
      isPreviewing={false}
      previewPath="/v1/responses"
      previewBody="{}"
      previewHeaders={'{"synthetic-header":"kept"}'}
      preview={null}
      previewError="Invalid synthetic header"
      onPathChange={() => undefined}
      onBodyChange={() => undefined}
      onHeadersChange={() => undefined}
      onPreviewSubmit={() => undefined}
      onPreviewClear={() => undefined}
    />);
    expect(markup).toContain('<details class="config-preview-headers" open="">');
    expect(markup).toContain("synthetic-header");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("检查左侧输入后重试。");
  });
});
