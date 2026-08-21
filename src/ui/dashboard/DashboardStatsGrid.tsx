import type {
  HealthResponse,
  RouteKind
} from "../../shared/types.js";
import { upstreamHealthBadge } from "../health/health-status.js";
import { pagePathForStudioPage } from "../routing.js";

export function DashboardStatsGrid({
  health,
  listen,
  logCounts
}: {
  health: HealthResponse | null;
  listen: string;
  logCounts: Record<"all" | RouteKind, number>;
}) {
  const codexPrimaryOk = upstreamHealthBadge(health?.primary).tone === "good";
  const codexCompactOk = upstreamHealthBadge(health?.compact).tone === "good";
  const claudeOk = upstreamHealthBadge(health?.claude?.primary).tone === "good";
  const totalRoutes = 3;
  const readyRoutes = [codexPrimaryOk, codexCompactOk, claudeOk].filter(Boolean).length;
  const allReady = readyRoutes === totalRoutes;

  return (
    <div className="dashboard-grid">
      <div className="stat-card">
        <div className="stat-card-label">服务端点</div>
        <div className="endpoint-display">
          <span className="route-chip codex">OpenAI</span>
          <code>http://{listen}/v1</code>
        </div>
        <div className="endpoint-display">
          <span className="route-chip claude">Claude</span>
          <code>http://{listen}/anthropic</code>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-label">最近流量</div>
        <div className="dashboard-stat-count-grid">
          <div>
            <div className="stat-card-value">{logCounts.primary}</div>
            <div className="stat-card-meta">Codex 主路由</div>
          </div>
          <div>
            <div className="stat-card-value">{logCounts.compact}</div>
            <div className="stat-card-meta">Compact 压缩</div>
          </div>
          <div>
            <div className="stat-card-value">{logCounts.claude}</div>
            <div className="stat-card-meta">Claude 路由</div>
          </div>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-label">上游状态</div>
        <div className={`dashboard-health-summary ${allReady ? "is-good" : "is-warn"}`}>
          <div className="dashboard-health-summary-value">{readyRoutes}/{totalRoutes}</div>
          <div className="dashboard-health-summary-meta">
            {allReady ? "全部上游可用" : `${totalRoutes - readyRoutes} 条路由需要关注`}
          </div>
          <a className="dashboard-health-summary-link" href={pagePathForStudioPage("health")}>查看详情 →</a>
        </div>
      </div>
    </div>
  );
}
