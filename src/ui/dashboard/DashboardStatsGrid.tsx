import { useState } from "react";
import type {
  HealthResponse,
  RouteKind
} from "../../shared/types.js";
import { upstreamHealthBadge } from "../health/health-status.js";
import { pagePathForStudioPage } from "../routing.js";
import { errorSummary } from "../shared/api.js";

export function DashboardStatsGrid({
  health,
  listen,
  logCounts
}: {
  health: HealthResponse | null;
  listen: string | null;
  logCounts: Record<"all" | RouteKind, number> | null;
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
        {listen ? <>
          <EndpointDisplay key={`openai-${listen}`} label="OpenAI" tone="codex" endpoint={`http://${listen}/v1`} />
          <EndpointDisplay key={`claude-${listen}`} label="Claude" tone="claude" endpoint={`http://${listen}/anthropic`} />
        </> : <p role="status">等待配置数据</p>}
      </div>

      <div className="stat-card">
        <div className="stat-card-label">保留日志累计</div>
        <div className="dashboard-stat-count-grid">
          <div>
            <div className="stat-card-value">{logCounts?.primary ?? "—"}</div>
            <div className="stat-card-meta">Codex 主路由</div>
          </div>
          <div>
            <div className="stat-card-value">{logCounts?.compact ?? "—"}</div>
            <div className="stat-card-meta">Compact 压缩</div>
          </div>
          <div>
            <div className="stat-card-value">{logCounts?.claude ?? "—"}</div>
            <div className="stat-card-meta">Claude 路由</div>
          </div>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-card-label">上游配置</div>
        <div className={`dashboard-health-summary ${allReady ? "is-good" : "is-warn"}`}>
          <div className="dashboard-health-summary-value">{health ? `${readyRoutes}/${totalRoutes}` : "—"}</div>
          <div className="dashboard-health-summary-meta">
            {!health ? "等待健康数据" : allReady ? "全部配置就绪" : `${totalRoutes - readyRoutes} 条路由需要关注`}
          </div>
          <a className="dashboard-health-summary-link" href={pagePathForStudioPage("health")}>查看详情 →</a>
        </div>
      </div>
    </div>
  );
}

function EndpointDisplay({ label, tone, endpoint }: { label: string; tone: string; endpoint: string }) {
  const [copyResult, setCopyResult] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopyResult("已复制");
    } catch (cause) {
      setCopyResult(`复制失败：${errorSummary(cause)}`);
    }
  }
  return (
    <div className="endpoint-display">
      <span className={`route-chip ${tone}`}>{label}</span>
      <code>{endpoint}</code>
      <button className="btn btn-sm" type="button" aria-label={`复制 ${label} 端点`} onClick={() => void copy()}>{copyResult === "已复制" ? "已复制" : "复制"}</button>
      <span className={copyResult.startsWith("复制失败") ? "endpoint-copy-status" : "visually-hidden"} role="status">{copyResult}</span>
    </div>
  );
}
