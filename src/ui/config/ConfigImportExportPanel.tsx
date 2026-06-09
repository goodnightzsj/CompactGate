import { useId } from "react";
import type * as React from "react";
import type { PublicConfig } from "../../shared/types.js";
import type {
  ConfigImportSummary,
  ImportCandidate,
  ImportState
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
  onFileChange,
  onExportConfig,
  onConfirmImport,
  onClearImport
}: {
  config: PublicConfig | null;
  importCandidate: ImportCandidate | null;
  importState: ImportState;
  importError: string | null;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onExportConfig: () => void | Promise<void>;
  onConfirmImport: () => void | Promise<void>;
  onClearImport: () => void;
}) {
  const fileInputId = useId();
  const summaryItems = importCandidate ? importSummaryItems(importCandidate.summary) : [];

  return (
    <section className="config-portable-panel" aria-labelledby="config-portable-title">
      <div className="config-portable-head">
        <div>
          <p className="eyebrow">Portable Config</p>
          <h3 id="config-portable-title">配置导入导出</h3>
          <p>
            导出当前配置为 compactgate JSON，或选择文件后先核对摘要，再确认覆盖当前运行时配置。
            URL 预设只包含地址元数据；导入摘要不会显示任何 API key 值。
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!config}
          onClick={() => void onExportConfig()}
        >
          导出配置
        </button>
      </div>

      <div className="config-portable-grid">
        <div className="config-portable-card">
          <label className="config-file-drop" htmlFor={fileInputId}>
            <span>选择 compactgate.json</span>
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

          {importError && <div className="error-banner">{importError}</div>}
          {importState === "imported" && (
            <div className="inline-success" role="status">
              导入完成，当前运行时配置已经刷新。
            </div>
          )}
        </div>

        <div className="config-import-summary" aria-live="polite">
          {importCandidate ? (
            <>
              <div className="config-import-summary-head">
                <strong>即将导入的配置摘要</strong>
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
                  导入会把文件作为新的完整配置保存，缺失字段由默认值补齐。这个操作不会增加 URL 预设使用次数。
                </p>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={importState === "importing"}
                  onClick={() => void onConfirmImport()}
                >
                  {importState === "importing" ? "正在导入..." : "确认覆盖当前配置"}
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
    { label: "保留日志", value: summary.keepRecent === null ? "默认或未声明" : `${summary.keepRecent} 条` },
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
