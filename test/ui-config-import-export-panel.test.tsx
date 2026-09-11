import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConfigImportExportPanel } from "../src/ui/config/ConfigImportExportPanel.js";

it("keeps the complete-backup sensitivity and unsaved-draft boundary beside export", () => {
  const markup = renderToStaticMarkup(<ConfigImportExportPanel config={null} importCandidate={null}
    importState="idle" importError={null} onFileChange={() => {}} onExportConfig={() => {}}
    onConfirmImport={() => {}} onClearImport={() => {}} />);
  expect(markup).toContain("导出完整备份");
  expect(markup).toContain("包含已保存配置和当前未保存草稿");
  expect(markup).toContain("可能含直填 API key");
  expect(markup).toContain("OAuth 仅含连接引用，不含授权令牌");
  expect(markup).toMatch(/aria-describedby="[^"]+-export-note"/);
});
