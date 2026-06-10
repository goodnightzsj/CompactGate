import type * as React from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type { RoutePreviewResponse } from "../../shared/types.js";

export function ConfigPreviewPanel({
  previewPath,
  previewBody,
  preview,
  previewError,
  onPathChange,
  onBodyChange,
  onPreviewSubmit
}: {
  previewPath: string;
  previewBody: string;
  preview: RoutePreviewResponse | null;
  previewError: string | null;
  onPathChange: (path: string) => void;
  onBodyChange: (body: string) => void;
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
      {previewError && <div className="error-banner">{previewError}</div>}
      <button className="btn btn-primary" onClick={onPreviewSubmit}>预览路由</button>
      {preview && (
        <div className="config-preview-result">
          <div><span className="field-hint">路由</span><div><span className={`route-chip ${preview.route}`}>{routeLabel(preview.route)}</span></div></div>
          <div><span className="field-hint">上游</span><div className="config-preview-mono">{preview.upstream_host}</div></div>
          <div><span className="field-hint">原始模型</span><div><code>{preview.source_model ?? "-"}</code></div></div>
          <div><span className="field-hint">目标模型</span><div><code>{preview.target_model ?? "-"}</code></div></div>
        </div>
      )}
    </div>
  );
}
