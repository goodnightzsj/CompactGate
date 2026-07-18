import type * as React from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RoutePreviewResponse } from "../../shared/types.js";

export function ConfigPreviewPanel({
  previewPath,
  previewBody,
  previewHeaders,
  preview,
  previewError,
  onPathChange,
  onBodyChange,
  onHeadersChange,
  onPreviewSubmit
}: {
  previewPath: string;
  previewBody: string;
  previewHeaders: string;
  preview: RoutePreviewResponse | null;
  previewError: string | null;
  onPathChange: (path: string) => void;
  onBodyChange: (body: string) => void;
  onHeadersChange: (headers: string) => void;
  onPreviewSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <div className="config-preview-panel">
      <div className="field">
        <span className="field-label">请求路径</span>
        <div className="config-preview-actions">
          <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses")}>普通响应</button>
          <button type="button" className="btn btn-sm" onClick={() => onPathChange("/v1/responses/compact")}>压缩响应</button>
        </div>
        <input className="input" value={previewPath} onChange={(event) => onPathChange(event.target.value)} />
      </div>
      <div className="field">
        <span className="field-label">JSON 请求体</span>
        <textarea className="textarea config-preview-body" value={previewBody} onChange={(event) => onBodyChange(event.target.value)} rows={4} spellCheck={false} />
      </div>
      <div className="field">
        <span className="field-label">请求头 JSON</span>
        <textarea className="textarea config-preview-body" value={previewHeaders} onChange={(event) => onHeadersChange(event.target.value)} rows={3} spellCheck={false} />
      </div>
      {previewError && <div className="error-banner">{previewError}</div>}
      <button className="btn btn-primary" onClick={onPreviewSubmit}>预览路由</button>
      {preview && (
        <div className="config-preview-result">
          <div><span className="field-hint">路由</span><div><span className={`route-chip ${preview.route}`}>{routeLabel(preview.route)}</span></div></div>
          <div><span className="field-hint">压缩模式</span><div><code>{preview.compaction_mode ?? "-"}</code></div></div>
          <div><span className="field-hint">判定来源</span><div><code>{preview.detection_source ?? "-"}</code></div></div>
          <div><span className="field-hint">上游</span><div className="config-preview-mono">{preview.upstream_host}</div></div>
          <div><span className="field-hint">原始模型</span><div><code>{preview.source_model ?? "-"}</code></div></div>
          <div><span className="field-hint">目标模型</span><div><code>{preview.target_model ?? "-"}</code></div></div>
        </div>
      )}
    </div>
  );
}
