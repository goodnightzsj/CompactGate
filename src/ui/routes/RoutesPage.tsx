import type { ComponentProps } from "react";
import { routeLabel } from "../../shared/route-meta.js";
import type {
  ClientIdentityStatus,
  CodexVersionStatus,
  OpenAiCompactionMode,
  PublicConfig,
  RequestLogEntry,
  RouteKind
} from "../../shared/types.js";
import { ClientIdentityPanel } from "./ClientIdentityPanel.js";
import { CodexProtocolStatus } from "./CodexProtocolStatus.js";
import { RouteRulesGrid } from "./RouteRulesGrid.js";
import type { RouteHitSource } from "./RouteRulesGrid.js";
import { ConfigPreviewPanel } from "../config/ConfigPreviewPanel.js";
import { logStatusKind } from "../logs/log-utils.js";

export function RoutesPage({
  config,
  currentModel,
  compactModel,
  compactMode,
  hasPendingChanges,
  activeRoute,
  activeCompactionMode,
  activeRouteSource,
  latestLog,
  hasLogSnapshot,
  logError,
  onRetryLogs,
  codexStatus,
  clientIdentity,
  previewPanel
}: {
  config: PublicConfig | null;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  hasPendingChanges: boolean;
  activeRoute: RouteKind | null;
  activeCompactionMode: OpenAiCompactionMode | null;
  activeRouteSource: RouteHitSource;
  latestLog: RequestLogEntry | null;
  hasLogSnapshot: boolean;
  logError: string | null;
  onRetryLogs: () => void;
  codexStatus: CodexVersionStatus | null;
  clientIdentity: ClientIdentityStatus | null;
  previewPanel: ComponentProps<typeof ConfigPreviewPanel>;
}) {
  const hitTone = activeRouteSource === "latest" && hasLogSnapshot && latestLog
    ? logStatusKind(latestLog) === "error" ? "is-bad" : "is-good"
    : "";

  return (
    <div className="routes-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">路由规则</p>
          <h2>分流逻辑</h2>
          <p className="page-description">先核对已生效规则，再用请求试算定位分流；试算不会发送上游请求。</p>
        </div>
        <div className="route-header-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => document.getElementById("route-preview-title")?.focus()}
          >
            跳到路由试算 ↓
          </button>
          <span className={`status-pill route-hit-summary ${hitTone}`}>
          {activeRouteSource !== "preview" && !hasLogSnapshot
            ? logError ? "最近请求不可用" : "正在读取最近请求…"
            : formatRouteHitStatus(activeRoute, activeRouteSource, latestLog)}
          </span>
        </div>
      </div>

      {logError && <div className="error-banner" role="alert">
        最近请求更新失败：{logError} {hasLogSnapshot && "最近命中保留上次全局结果；试算不受影响。"}
        <button type="button" className="btn btn-sm" onClick={onRetryLogs}>重试日志</button>
      </div>}

      {hasPendingChanges && (
        <p className="route-draft-notice" role="status">
          配置页有未保存的改动。下面显示的是当前已生效的规则，保存后才会变化。
        </p>
      )}

      <div className="routes-workspace" role="region" aria-label="路由规则与试算" tabIndex={0}>
      {config ? <RouteRulesGrid
        listen={config.listen}
        primaryHost={config.primary.host}
        compactHost={config.compact.host}
        claudePrimaryHost={config.claude.primary.host}
        primaryProtocol={config?.primary.upstream_protocol ?? null}
        compactProtocol={config?.compact.upstream_protocol ?? null}
        claudeProtocol={config?.claude.primary.upstream_protocol ?? null}
        currentModel={currentModel}
        compactModel={compactModel}
        compactMode={compactMode}
        activeRoute={activeRoute}
        activeCompactionMode={activeCompactionMode}
        activeRouteSource={activeRouteSource}
      /> : <div className="panel" role="status">等待配置数据，尚未取得已生效的路由规则。</div>}

      <section className="route-preview-section" aria-labelledby="route-preview-title">
        <h3 id="route-preview-title" tabIndex={-1}>路由试算</h3>
        <ConfigPreviewPanel {...previewPanel} />
      </section>

      <details className="route-advanced-section">
        <summary>Codex 压缩协议详情 <span>{codexStatus?.protocol_source === "request" ? "实际观测" : "等待观测 / 版本基线"}</span></summary>
        <CodexProtocolStatus status={codexStatus} />
      </details>
      <details className="route-advanced-section">
        <summary>客户端 UA 改写 <span>{clientIdentity ? (clientIdentity.enabled ? "已启用 · 修改即时生效" : "已关闭") : "读取中"}</span></summary>
        <ClientIdentityPanel status={clientIdentity} />
      </details>
      </div>
    </div>
  );
}

function formatRouteHitStatus(
  activeRoute: RouteKind | null,
  source: RouteHitSource,
  latestLog: RequestLogEntry | null
): string {
  if (!activeRoute || source === "none") {
    return "等待试算或真实请求";
  }

  if (source === "preview") {
    return `路由试算 · ${routeLabel(activeRoute)}`;
  }

  return `最近请求 · ${routeLabel(activeRoute)} · ${latestLog?.status ?? "-"}`;
}
