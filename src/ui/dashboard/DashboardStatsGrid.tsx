import type {
  HealthResponse,
  PublicConfig,
  RouteKind
} from "../../shared/types.js";
import { upstreamHealthBadge } from "../health/health-status.js";

export function DashboardStatsGrid({
  config,
  health,
  listen,
  logCounts
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  listen: string;
  logCounts: Record<"all" | RouteKind, number>;
}) {
  const primaryHost = config?.primary.host ?? "-";
  const compactHost = config?.compact.host ?? "-";
  const claudeHost = config?.claude.primary.host ?? "-";
  const codexPrimaryOk = upstreamHealthBadge(health?.primary).tone === "good";
  const codexCompactOk = upstreamHealthBadge(health?.compact).tone === "good";
  const claudeOk = upstreamHealthBadge(health?.claude?.primary).tone === "good";

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
        <div className="dashboard-health-list">
          <div className="dashboard-health-row">
            <span className="dashboard-health-name">Codex 主路由</span>
            <span className="dashboard-health-host">{primaryHost}</span>
            <span className={`status-pill ${codexPrimaryOk ? "is-good" : "is-warn"}`}>{codexPrimaryOk ? "正常" : "异常"}</span>
          </div>
          <div className="dashboard-health-row">
            <span className="dashboard-health-name">Codex 压缩</span>
            <span className="dashboard-health-host">{compactHost}</span>
            <span className={`status-pill ${codexCompactOk ? "is-good" : "is-warn"}`}>{codexCompactOk ? "正常" : "异常"}</span>
          </div>
          <div className="dashboard-health-row">
            <span className="dashboard-health-name">Claude 主路由</span>
            <span className="dashboard-health-host">{claudeHost}</span>
            <span className={`status-pill ${claudeOk ? "is-good" : "is-warn"}`}>{claudeOk ? "正常" : "异常"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
