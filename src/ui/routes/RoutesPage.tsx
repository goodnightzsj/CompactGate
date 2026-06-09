import { routeLabel } from "../../shared/route-meta.js";
import type { PublicConfig, RequestLogEntry, RouteKind } from "../../shared/types.js";
import { RouteRulesGrid } from "./RouteRulesGrid.js";

export function RoutesPage({
  config,
  currentModel,
  compactModel,
  compactMode,
  activeRoute,
  latestLog
}: {
  config: PublicConfig | null;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  activeRoute: RouteKind;
  latestLog: RequestLogEntry | null;
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
        <span className="status-pill">
          最近命中: {formatLatestLogStatus(latestLog, "等待请求")}
        </span>
      </div>

      <RouteRulesGrid
        listen={listen}
        primaryHost={primaryHost}
        compactHost={compactHost}
        claudePrimaryHost={claudePrimaryHost}
        currentModel={currentModel}
        compactModel={compactModel}
        compactMode={compactMode}
        activeRoute={activeRoute}
      />
    </>
  );
}

function formatLatestLogStatus(entry: RequestLogEntry | null, fallback: string): string {
  return entry ? `${routeLabel(entry.route)} · 状态 ${entry.status}` : fallback;
}
