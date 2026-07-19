import { routeLabel } from "../../shared/route-meta.js";
import type {
  CodexVersionStatus,
  OpenAiCompactionMode,
  PublicConfig,
  RequestLogEntry,
  RouteKind
} from "../../shared/types.js";
import { CodexProtocolStatus } from "./CodexProtocolStatus.js";
import { RouteRulesGrid } from "./RouteRulesGrid.js";
import type { RouteHitSource } from "./RouteRulesGrid.js";

export function RoutesPage({
  config,
  currentModel,
  compactModel,
  compactMode,
  activeRoute,
  activeCompactionMode,
  activeRouteSource,
  latestLog,
  codexStatus
}: {
  config: PublicConfig | null;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  activeRoute: RouteKind | null;
  activeCompactionMode: OpenAiCompactionMode | null;
  activeRouteSource: RouteHitSource;
  latestLog: RequestLogEntry | null;
  codexStatus: CodexVersionStatus | null;
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";
  const primaryHost = config?.primary.host ?? "primary.example";
  const compactHost = config?.compact.host ?? "compact.example";
  const claudePrimaryHost = config?.claude.primary.host ?? "api.anthropic.com";

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">路由规则</p>
          <h2>分流逻辑</h2>
        </div>
        <span className={`status-pill route-hit-summary ${activeRouteSource === "none" ? "" : "is-good"}`}>
          {formatRouteHitStatus(activeRoute, activeRouteSource, latestLog)}
        </span>
      </div>

      <CodexProtocolStatus status={codexStatus} />

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
    </>
  );
}

function formatRouteHitStatus(
  activeRoute: RouteKind | null,
  source: RouteHitSource,
  latestLog: RequestLogEntry | null
): string {
  if (!activeRoute || source === "none") {
    return "等待预览或真实请求";
  }

  if (source === "preview") {
    return `路由预览 · ${routeLabel(activeRoute)}`;
  }

  return `最近请求 · ${routeLabel(activeRoute)} · ${latestLog?.status ?? "-"}`;
}
