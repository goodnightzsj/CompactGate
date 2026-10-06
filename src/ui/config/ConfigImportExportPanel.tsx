import { useId } from "react";
import type * as React from "react";
import type { PublicConfig } from "../../shared/types.js";
import type {
  ConfigImportSummary,
  ImportCandidate,
  ImportState,
  ImportSubmission
} from "./config-import-summary.js";

type ImportSummaryItem = {
  label: string;
  value: string;
  tone?: "warn";
};

export function ConfigImportExportPanel({
  config,
  importCandidate,
  importState,
  importError,
  importSubmission,
  onFileChange,
  onExportConfig,
  onExportSavedConfig,
  onConfirmImport,
  onClearImport
}: {
  config: PublicConfig | null;
  importCandidate: ImportCandidate | null;
  importState: ImportState;
  importError: string | null;
  importSubmission: ImportSubmission | null;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onExportConfig: () => void | Promise<void>;
  onExportSavedConfig: () => void | Promise<void>;
  onConfirmImport: () => void | Promise<void>;
  onClearImport: () => void;
}) {
  const fileInputId = useId();
  const summaryItems = importCandidate ? importSummaryItems(importCandidate.summary) : [];

  return (
    <section className="config-portable-panel" aria-labelledby="config-portable-title">
      <div className="config-portable-head">
        <div>
          <p className="eyebrow">导出备份</p>
          <h3 id="config-portable-title">选择要保留的版本</h3>
          <p>
            备份当前配置，或从文件恢复。导入前先核对摘要，确认后才会覆盖当前运行配置。
            导入摘要不会显示任何 API key 值。
          </p>
        </div>
        <div className="config-export-action"><div className="config-export-option"><button
          type="button"
          className="btn btn-primary"
          disabled={!config}
          aria-describedby={`${fileInputId}-export-note`}
          onClick={() => void onExportConfig()}
        >
          导出完整备份
        </button>
        <p id={`${fileInputId}-export-note`}>包含已保存配置和当前未保存草稿，可能含直填 API key，请妥善保管。OAuth 仅含连接引用，不含授权令牌。</p></div>
        <div className="config-export-option">
        <button type="button" className="btn btn-ghost" disabled={!config}
          aria-describedby={`${fileInputId}-saved-export-note`}
          onClick={() => void onExportSavedConfig()}>仅导出已保存配置</button>
        <p id={`${fileInputId}-saved-export-note`}>仅导出已保存配置不会包含当前草稿，但同样可能含明文密钥；迁移 OAuth 连接后需重新授权。</p></div></div>
      </div>

      <div className="config-import-heading"><h3>从文件恢复</h3><p>选择文件 → 核对摘要 → 确认覆盖。选择文件本身不会更改当前配置。</p></div>
      <div className={`config-portable-grid ${importCandidate ? "has-candidate" : "is-awaiting-file"}`}>
        <div className="config-portable-card">
          <label className="config-file-drop" htmlFor={fileInputId}>
            <span>1 · 选择 compactgate.json</span>
            <strong>{importCandidate?.fileName ?? "尚未选择文件"}</strong>
            <small>
              {importCandidate
                ? `${formatBytes(importCandidate.sizeBytes)}，确认前不会写入。`
                : "本地解析后会显示覆盖摘要。"}
            </small>
          </label>
          <input
            id={fileInputId}
            className="config-file-input"
            type="file"
            accept="application/json,.json"
            onChange={onFileChange}
          />

          {importState === "reading" && <div role="status">正在读取文件… <button type="button" className="btn btn-sm btn-ghost" onClick={onClearImport}>取消读取</button></div>}
          {importError && <div className="error-banner" role="alert">{importError}</div>}
          {importSubmission?.status === "pending" && <div role="status">正在导入 {importSubmission.fileName}… 可以选择下一份文件，当前写入不会取消。</div>}
          {importSubmission?.status === "error" && <div className="error-banner" role="alert">导入 {importSubmission.fileName} 失败：{importSubmission.error}</div>}
          {importSubmission?.status === "success" && (
            <div className="inline-success" role="status">
              {importSubmission.fileName} 导入完成，当前运行时配置已经刷新。
            </div>
          )}
        </div>

        <div className="config-import-summary" aria-live="polite">
          {importCandidate ? (
            <>
              <div className="config-import-summary-head">
                <strong>2 · 即将导入的配置摘要</strong>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onClearImport}>
                  清除选择
                </button>
              </div>
              <dl className="config-import-summary-grid">
                {summaryItems.map((item) => (
                  <div key={item.label} className={item.tone === "warn" ? "is-warn" : ""}>
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
              <div className="config-import-confirm">
                <p>
                  3 · 确认后整体替换运行配置与档案列表，不是合并。缺失字段由默认值补齐；不会增加 URL 预设使用次数。建议先导出当前配置。
                </p>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={importSubmission?.status === "pending" || importState === "reading"}
                  onClick={() => void onConfirmImport()}
                >
                  {importSubmission?.status === "pending" ? "等待当前导入完成…" : "确认覆盖当前配置"}
                </button>
              </div>
            </>
          ) : (
            <div className="config-import-empty">
              <strong>先选择文件，再确认覆盖。</strong>
              <span>CompactGate 会先在浏览器中解析 JSON 并显示摘要；只有点击确认后才会写入后端配置文件。</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function importSummaryItems(summary: ConfigImportSummary): ImportSummaryItem[] {
  return [
    { label: "监听地址", value: summary.listen },
    { label: "Codex 主路由", value: summary.codexPrimaryHost },
    { label: "Codex 压缩路由", value: summary.codexCompactHost },
    { label: "Claude 主路由", value: summary.claudePrimaryHost },
    { label: "Codex 档案", value: `${summary.codexProfileCount}` },
    { label: "Claude 档案", value: `${summary.claudeProfileCount}` },
    { label: "URL 预设", value: `${summary.presetCount}` },
    { label: "每页日志", value: summary.keepRecent === null ? "默认或未声明" : `${summary.keepRecent} 条` },
    {
      label: "直填密钥",
      value: summary.hasDirectApiKeys ? "文件包含直填 API key；摘要已隐藏具体值。" : "未检测到直填 API key。",
      tone: summary.hasDirectApiKeys ? "warn" : undefined
    }
  ];
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
