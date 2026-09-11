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
  codexStatus: CodexVersionStatus | null;
  clientIdentity: ClientIdentityStatus | null;
  previewPanel: ComponentProps<typeof ConfigPreviewPanel>;
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";
  const primaryHost = config?.primary.host ?? "primary.example";
  const compactHost = config?.compact.host ?? "compact.example";
  const claudePrimaryHost = config?.claude.primary.host ?? "api.anthropic.com";

  return (
    <div className="routes-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">路由规则</p>
          <h2>分流逻辑</h2>
        </div>
        <div className="route-header-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => document.getElementById("route-preview-title")?.focus()}
          >
            跳到路由试算 ↓
          </button>
          <span className={`status-pill route-hit-summary ${activeRouteSource === "none" ? "" : "is-good"}`}>
          {formatRouteHitStatus(activeRoute, activeRouteSource, latestLog)}
          </span>
        </div>
      </div>

      {hasPendingChanges && (
        <p className="route-draft-notice" role="status">
          配置页有未保存的改动。下面显示的是当前已生效的规则，保存后才会变化。
        </p>
      )}

      <RouteRulesGrid
        listen={listen}
        primaryHost={primaryHost}
        compactHost={compactHost}
        claudePrimaryHost={claudePrimaryHost}
        currentModel={currentModel}
        compactModel={compactModel}
        compactMode={compactMode}
        activeRoute={activeRoute}
        activeCompactionMode={activeCompactionMode}
        activeRouteSource={activeRouteSource}
      />

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
