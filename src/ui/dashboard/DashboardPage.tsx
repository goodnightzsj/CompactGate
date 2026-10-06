import type {
  HealthResponse,
  PublicConfig,
  RequestLogEntry,
  RouteKind
} from "../../shared/types.js";
import { saveLabel } from "../config/save-state.js";
import type { SaveState } from "../config/types.js";
import { DashboardRecentRequests } from "./DashboardRecentRequests.js";
import { DashboardStatsGrid } from "./DashboardStatsGrid.js";
import { profileScopeState } from "../config/profile-utils.js";
import type { StudioPage } from "../app-types.js";

export function DashboardPage({
  config,
  health,
  logs,
  logCounts,
  logError,
  onRetryLogs,
  saveState,
  hasPendingChanges,
  onExport,
  onNavigate
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  logs: RequestLogEntry[];
  logCounts: Record<"all" | RouteKind, number> | null;
  logError: string | null;
  onRetryLogs: () => void;
  saveState: SaveState;
  hasPendingChanges: boolean;
  onExport: () => void | Promise<void>;
  onNavigate: (page: StudioPage) => void;
}) {
  const listen = config?.listen ?? null;

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">总览</p>
          <h2>CompactGate 控制台</h2>
        </div>
        <div className="dashboard-header-actions">
          <span className={`status-pill ${listen ? "is-good" : ""}`}>{listen ? `监听 ${listen}` : "等待配置数据"}</span>
          {config && <span className="status-pill">
            {saveLabel(saveState, hasPendingChanges, config.last_saved_at)}
          </span>}
          <button className="btn btn-sm" disabled={!config} onClick={() => void onExport()}>导出配置</button>
        </div>
      </div>

      {logError && <div className="error-banner" role="alert">
        最近请求更新失败：{logError} {logCounts && "以下为上次取得的全局结果。"}
        <button type="button" className="btn btn-sm" onClick={onRetryLogs}>重试日志</button>
      </div>}

      <DashboardStatsGrid
        health={health}
        listen={listen}
        logCounts={logCounts}
      />

      {config && <section className="dashboard-routing" aria-labelledby="dashboard-routing-title">
        <div className="dashboard-routing-header">
          <div><h3 id="dashboard-routing-title">当前运行配置</h3><p>已生效的连接与主模型；配置就绪不代表上游连通。</p></div>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate("config")}>{hasPendingChanges ? "继续编辑草稿" : "管理配置"} →</button>
        </div>
        <div className="dashboard-routing-rows">
          {(["codex", "claude"] as const).map((scope) => {
            const state = profileScopeState(config, scope);
            const active = state.profiles.find((profile) => profile.id === state.active_profile_id);
            const upstream = scope === "codex" ? config.primary : config.claude.primary;
            return <div className="dashboard-routing-row" key={scope}>
              <span className={`route-chip ${scope}`}>{scope === "codex" ? "Codex" : "Claude"}</span>
              <div><small>当前档案</small><strong>{active?.name ?? "独立运行配置"}</strong></div>
              <div><small>主路由 Host</small><code>{upstream.host}</code></div>
              <div><small>主模型覆盖</small><code>{upstream.model_override || "未设置 · 按请求规则路由"}</code></div>
            </div>;
          })}
        </div>
        <div className="dashboard-next-actions" aria-label="分析与排查入口">
          <span>{hasPendingChanges ? "未保存草稿尚未应用到以上配置。" : "继续查看"}</span>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate("analytics")}>流量与延迟 ↗</button>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate("usage")}>用量与缓存 ↗</button>
          <button type="button" className="btn btn-sm" onClick={() => onNavigate("routes")}>路由试算 ↗</button>
        </div>
      </section>}

      {logCounts && listen ? <DashboardRecentRequests logs={logs} totalCount={logCounts.all} listen={listen} /> :
        <p role="status">{!listen ? "等待配置数据以显示最近请求。" : logError ? "尚未取得全局请求数据。" : "正在读取全局最近请求…"}</p>}
    </div>
  );
}
