import type {
  HealthResponse,
  ProviderLogCounts,
  PublicConfig,
  RequestLogEntry,
  RouteKind
} from "../../shared/types.js";
import { saveLabel } from "../config/save-state.js";
import type { SaveState } from "../config/types.js";
import { DashboardRecentRequests } from "./DashboardRecentRequests.js";
import { DashboardStatsGrid } from "./DashboardStatsGrid.js";

export function DashboardPage({
  config,
  health,
  logs,
  logCounts,
  providerCounts,
  saveState,
  hasPendingChanges,
  onExport
}: {
  config: PublicConfig | null;
  health: HealthResponse | null;
  logs: RequestLogEntry[];
  logCounts: Record<"all" | RouteKind, number>;
  providerCounts: ProviderLogCounts;
  saveState: SaveState;
  hasPendingChanges: boolean;
  onExport: () => void | Promise<void>;
}) {
  const listen = config?.listen ?? "127.0.0.1:7865";

  return (
    <>
      <div className="page-header">
        <div>
          <p className="eyebrow">总览</p>
          <h2>CompactGate 控制台</h2>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span className="status-pill is-good">监听 {listen}</span>
          <span className="status-pill">
            {saveLabel(saveState, hasPendingChanges, config?.last_saved_at)}
          </span>
          <button className="btn btn-sm" onClick={() => void onExport()}>导出配置</button>
        </div>
      </div>

      <DashboardStatsGrid
        config={config}
        health={health}
        listen={listen}
        logCounts={logCounts}
        providerCounts={providerCounts}
      />

      <DashboardRecentRequests logs={logs} listen={listen} />
    </>
  );
}
