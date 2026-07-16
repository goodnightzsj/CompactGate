import type { HealthBadge } from "../app-types.js";
import { formatDateTime } from "../shared/format.js";

export function HealthHeroSection({
  overallStatus,
  readyRoutes,
  attentionRoutes,
  failedRoutes,
  totalRoutes,
  listenUrl,
  refreshedAt,
  isRefreshing
}: {
  overallStatus: HealthBadge;
  readyRoutes: number;
  attentionRoutes: number;
  failedRoutes: number;
  totalRoutes: number;
  listenUrl: string;
  refreshedAt: string | null;
  isRefreshing: boolean;
}) {
  const refreshLabel = refreshedAt ? formatDateTime(refreshedAt) : "读取中...";

  return (
    <section className={`health-hero tone-${overallStatus.tone}`} aria-labelledby="health-title" aria-live="polite">
      <div className="health-status-board">
        <span className={`health-state-badge is-${overallStatus.tone}`}>总体</span>
        <strong id="health-title">{overallStatus.label}</strong>
        <small>{refreshedAt ? `刷新于 ${refreshLabel}` : "等待首次健康采样"}</small>
      </div>

      <div className="health-hero-readout">
        <div className="health-mini-card">
          <span>可用上游</span>
          <strong>{readyRoutes}/{totalRoutes}</strong>
          <small>{failedRoutes > 0 ? `${failedRoutes} 条异常` : attentionRoutes > 0 ? `${attentionRoutes} 条需要补全` : "所有路由已就绪"}</small>
        </div>
        <div className="health-mini-card">
          <span>监听地址</span>
          <strong>{listenUrl}</strong>
          <small>本地代理绑定入口</small>
        </div>
        <div className="health-mini-card">
          <span>最近刷新</span>
          <strong>{refreshLabel}</strong>
          <small>{isRefreshing ? "正在重新采样" : "自动轮询中"}</small>
        </div>
      </div>
    </section>
  );
}
