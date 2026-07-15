import { useId, useState } from "react";
import type {
  CapturePayload,
  CaptureRecord,
  CaptureResponsePayload,
  RequestLogEntry
} from "../../shared/types.js";
import {
  CaptureRequestError,
  captureDownloadUrl,
  fetchCaptureRecord
} from "./capture-client.js";

type CaptureStage =
  | "incoming_request"
  | "upstream_request"
  | "upstream_response"
  | "client_response";
type ViewState = "idle" | "loading" | "loaded" | "pending" | "absent" | "purged" | "error";

const STAGES: Array<{ id: CaptureStage; label: string }> = [
  { id: "incoming_request", label: "入站请求" },
  { id: "upstream_request", label: "上游请求" },
  { id: "upstream_response", label: "上游响应" },
  { id: "client_response", label: "客户端响应" }
];

export function LogCaptureViewer({ entry }: { entry: RequestLogEntry }) {
  const panelId = useId();
  const [viewState, setViewState] = useState<ViewState>("idle");
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [activeStage, setActiveStage] = useState<CaptureStage>("incoming_request");
  const [error, setError] = useState<string | null>(null);
  const effectiveStatus = capture
    ? "present"
    : viewState === "pending"
      ? "pending"
      : viewState === "purged"
        ? "purged"
        : viewState === "absent"
          ? "none"
          : entry.capture_status;

  const loadCapture = async () => {
    setViewState("loading");
    setError(null);
    try {
      const record = await fetchCaptureRecord(entry.request_id);
      setCapture(record);
      setViewState("loaded");
    } catch (loadError) {
      setCapture(null);
      if (loadError instanceof CaptureRequestError) {
        if (loadError.status === 202) {
          setViewState("pending");
          return;
        }
        if (loadError.status === 404) {
          setViewState("absent");
          return;
        }
        if (loadError.status === 410) {
          setViewState("purged");
          return;
        }
      }
      setError(loadError instanceof Error ? loadError.message : "抓包读取失败");
      setViewState("error");
    }
  };

  return (
    <section className="log-detail-section is-wide is-capture" aria-labelledby={`${panelId}-title`}>
      <div className="log-detail-section-head log-capture-head">
        <div>
          <span className="log-detail-kicker">原始数据</span>
          <h3 id={`${panelId}-title`}>请求 / 响应抓包</h3>
        </div>
        <div className="log-capture-statuses" aria-label="正文存储状态">
          <span className={`log-capture-status is-${entry.body_status}`}>
            SQLite {bodyStatusLabel(entry.body_status)}
          </span>
          <span className={`log-capture-status is-${effectiveStatus}`}>
            抓包 {captureStatusLabel(effectiveStatus)}
          </span>
        </div>
      </div>

      {!capture && (
        <CaptureEmptyState
          status={effectiveStatus}
          viewState={viewState}
          error={error}
          onLoad={() => void loadCapture()}
        />
      )}

      {capture && (
        <div className="log-capture-viewer">
          <div className="log-capture-toolbar">
            <div className="log-capture-tabs" role="tablist" aria-label="抓包阶段">
              {STAGES.map((stage) => (
                <button
                  key={stage.id}
                  type="button"
                  role="tab"
                  aria-selected={activeStage === stage.id}
                  aria-controls={`${panelId}-payload`}
                  className={activeStage === stage.id ? "is-active" : ""}
                  onClick={() => setActiveStage(stage.id)}
                >
                  {stage.label}
                </button>
              ))}
            </div>
            <a
              className="ghost-button log-capture-download"
              href={captureDownloadUrl(entry.request_id)}
              download={`compactgate-capture-${entry.request_id}.json`}
            >
              下载 JSON
            </a>
          </div>
          <CapturePayloadPanel
            id={`${panelId}-payload`}
            stage={activeStage}
            payload={payloadForStage(capture, activeStage)}
          />
        </div>
      )}
    </section>
  );
}

function CaptureEmptyState({
  status,
  viewState,
  error,
  onLoad
}: {
  status: RequestLogEntry["capture_status"];
  viewState: ViewState;
  error: string | null;
  onLoad: () => void;
}) {
  if (viewState === "loading") {
    return (
      <div className="log-capture-empty" role="status" aria-live="polite">
        <strong>正在读取抓包</strong>
        <span>只在当前展开项中加载原始请求与响应。</span>
      </div>
    );
  }
  if (viewState === "error") {
    return (
      <div className="log-capture-empty is-error" role="alert">
        <strong>抓包读取失败</strong>
        <span>{error ?? "未知错误"}</span>
        <button type="button" className="ghost-button" onClick={onLoad}>
          重试
        </button>
      </div>
    );
  }
  if (status === "pending") {
    return (
      <div className="log-capture-empty is-pending" role="status">
        <strong>抓包仍在写入</strong>
        <span>请求日志已生成，原始文件尚未完成关联。</span>
        <button type="button" className="ghost-button" onClick={onLoad}>
          重新检查
        </button>
      </div>
    );
  }
  if (status === "purged") {
    return (
      <div className="log-capture-empty is-purged">
        <strong>原始文件已清理</strong>
        <span>目录容量回收已删除抓包，但本条请求元数据仍完整保留。</span>
      </div>
    );
  }
  if (status === "none") {
    return (
      <div className="log-capture-empty">
        <strong>本次请求没有抓包</strong>
        <span>请求发生时抓包未启用，或文件写入没有成功。</span>
      </div>
    );
  }

  return (
    <div className="log-capture-empty">
      <strong>抓包可用</strong>
      <span>内容可能包含敏感提示词，仅在需要诊断时加载。</span>
      <button type="button" className="solid-button" onClick={onLoad}>
        查看抓包
      </button>
    </div>
  );
}

function CapturePayloadPanel({
  id,
  stage,
  payload
}: {
  id: string;
  stage: CaptureStage;
  payload: CapturePayload | CaptureResponsePayload | null;
}) {
  if (!payload) {
    return (
      <div id={id} role="tabpanel" className="log-capture-payload is-empty">
        客户端响应未单独缓冲；透明转发时这是正常状态。
      </div>
    );
  }

  return (
    <div id={id} role="tabpanel" className="log-capture-payload">
      <div className="log-capture-payload-meta">
        {"status" in payload && <span>HTTP {payload.status}</span>}
        <span>原始 {formatBytes(payload.body.byte_length)}</span>
        <span>已保存 {formatBytes(payload.body.captured_byte_length)}</span>
        {payload.body.truncated && <span className="is-warn">已截断</span>}
      </div>
      <details className="log-capture-headers">
        <summary>{stage.includes("response") ? "响应头" : "请求头"}</summary>
        <pre>{JSON.stringify(payload.headers, null, 2)}</pre>
      </details>
      <pre className="log-capture-body">{payload.body.text || "（空正文）"}</pre>
    </div>
  );
}

function payloadForStage(
  capture: CaptureRecord,
  stage: CaptureStage
): CapturePayload | CaptureResponsePayload | null {
  return capture[stage];
}

function captureStatusLabel(status: RequestLogEntry["capture_status"]): string {
  if (status === "pending") return "写入中";
  if (status === "present") return "可查看";
  if (status === "purged") return "已清理";
  return "未保存";
}

function bodyStatusLabel(status: RequestLogEntry["body_status"]): string {
  if (status === "present") return "有正文";
  if (status === "purged") return "已清理";
  return "仅元数据";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}
