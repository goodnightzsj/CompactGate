import type {
  HealthResponse,
  ProviderLogCounts,
  PublicConfig,
  RouteKind
} from "../../shared/types.js";
import { upstreamHealthBadge } from "../health/health-status.js";

export function DashboardStatsGrid({
  config,
  health,
  listen,
  logCounts,
  providerCounts
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  listen: string;
  logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts;
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginTop: 12 }}>
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
        <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--ink)" }}>Codex 主路由</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", color: "var(--muted)" }}>{primaryHost}</span>
            <span className={`status-pill ${codexPrimaryOk ? "is-good" : "is-warn"}`}>{codexPrimaryOk ? "正常" : "异常"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--ink)" }}>Codex 压缩</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", color: "var(--muted)" }}>{compactHost}</span>
            <span className={`status-pill ${codexCompactOk ? "is-good" : "is-warn"}`}>{codexCompactOk ? "正常" : "异常"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--ink)" }}>Claude 主路由</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.76rem", color: "var(--muted)" }}>{claudeHost}</span>
            <span className={`status-pill ${claudeOk ? "is-good" : "is-warn"}`}>{claudeOk ? "正常" : "异常"}</span>
          </div>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-label">Provider 汇总</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 12 }}>
          <div>
            <div className="stat-card-value">{providerCounts.openai}</div>
            <div className="stat-card-meta">Codex / OpenAI</div>
          </div>
          <div>
            <div className="stat-card-value">{providerCounts.claude}</div>
            <div className="stat-card-meta">Claude</div>
          </div>
        </div>
      </div>
    </div>
  );
}
