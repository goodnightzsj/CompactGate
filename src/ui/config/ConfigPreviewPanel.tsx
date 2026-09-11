import type * as React from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RoutePreviewResponse } from "../../shared/types.js";
import { upstreamProtocolLabel } from "./profile-utils.js";

export function ConfigPreviewPanel({
  isPreviewing,
  previewPath,
  previewBody,
  previewHeaders,
  preview,
  previewError,
  onPathChange,
  onBodyChange,
  onHeadersChange,
  onPreviewSubmit,
  onPreviewClear
}: {
  isPreviewing: boolean;
  previewPath: string;
  previewBody: string;
  previewHeaders: string;
  preview: RoutePreviewResponse | null;
  previewError: string | null;
  onPathChange: (path: string) => void;
  onBodyChange: (body: string) => void;
  onHeadersChange: (headers: string) => void;
  onPreviewSubmit: (event: React.FormEvent) => void;
  onPreviewClear: () => void;
}) {
  return (
    <div className="config-preview-panel">
      <form className="config-preview-inputs" onSubmit={onPreviewSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="preview-path">请求路径</label>
        <div className="config-preview-actions">
          <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses")}>普通响应</button>
          <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses/compact")}>压缩响应</button>
          <button type="button" className="btn btn-sm" onClick={() => onPathChange("/anthropic/v1/messages")}>Claude 消息</button>
        </div>
        <input id="preview-path" className="input" value={previewPath} onChange={(event) => onPathChange(event.target.value)} />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="preview-body">JSON 请求体</label>
        <textarea id="preview-body" className="textarea config-preview-body" value={previewBody} onChange={(event) => onBodyChange(event.target.value)} rows={6} spellCheck={false} />
      </div>
      <details className="config-preview-headers" open={Boolean(previewError)}>
        <summary>请求头 <span>JSON · 可选</span></summary>
        <div className="field">
        <label className="field-label" htmlFor="preview-headers">请求头 JSON</label>
        <textarea id="preview-headers" className="textarea config-preview-body" value={previewHeaders} onChange={(event) => onHeadersChange(event.target.value)} rows={3} spellCheck={false} />
        </div>
      </details>
      {previewError && <div className="error-banner" role="alert">{previewError}</div>}
      <div className="config-preview-actions">
        <button type="submit" className="btn btn-primary" disabled={isPreviewing}>{isPreviewing ? "试算中..." : "试算路由"}</button>
        {(preview || previewError || isPreviewing) && (
          <button type="button" className="btn btn-sm" onClick={onPreviewClear}>
            {isPreviewing ? "取消试算" : "清除试算"}
          </button>
        )}
      </div>
      </form>
      <section className="config-preview-output" aria-label="路由试算结果" aria-live="polite" aria-busy={isPreviewing}>
        <h3>试算结果</h3>
        <p>基于已保存的配置，不包含未保存草稿。</p>
      {preview ? (
        <div className="config-preview-result">
          <div><span className="field-hint">路由</span><div><span className={`route-chip ${preview.route}`}>{routeLabel(preview.route)}</span></div></div>
          <div><span className="field-hint">压缩模式</span><div><code>{preview.compaction_mode ?? "-"}</code></div></div>
          <div><span className="field-hint">判定来源</span><div><code>{preview.detection_source ?? "-"}</code></div></div>
          <div><span className="field-hint">上游</span><div className="config-preview-mono">{preview.upstream_host}</div></div>
          <div><span className="field-hint">入口协议</span><div><code>{protocolPreviewLabel(preview.ingress_protocol)}</code></div></div>
          <div><span className="field-hint">上游协议</span><div><code>{protocolPreviewLabel(preview.upstream_protocol)}</code></div></div>
          <div><span className="field-hint">协议路径</span><div><code>{preview.translation_mode === "translate" ? "协议转换 (translate)" : "直通 (passthrough)"}</code></div></div>
          <div><span className="field-hint">原始模型</span><div><code>{preview.source_model ?? "-"}</code></div></div>
          <div><span className="field-hint">目标模型</span><div><code>{preview.target_model ?? "-"}</code></div></div>
        </div>
      ) : <p className="config-preview-empty">
        <strong>{isPreviewing ? "正在试算..." : previewError ? "试算失败" : "选择路径后试算路由"}</strong>
        <span>{previewError ? "检查左侧输入后重试。" : "填写 JSON 请求体并点击“试算路由”；只计算路由，不向上游发送请求。"}</span>
      </p>}
      </section>
    </div>
  );
}

function protocolPreviewLabel(protocol: RoutePreviewResponse["ingress_protocol"]): string {
  return `${upstreamProtocolLabel(protocol)} (${protocol})`;
}
