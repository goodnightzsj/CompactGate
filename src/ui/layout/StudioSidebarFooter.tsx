import type { HealthBadge, ThemeMode } from "../app-types.js";

export function StudioSidebarFooter({
  primaryStatus,
  compactStatus,
  claudePrimaryStatus,
  themeMode,
  onThemeModeChange
}: {
  primaryStatus: HealthBadge;
  compactStatus: HealthBadge;
  claudePrimaryStatus: HealthBadge;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  return (
    <div className="sidebar-footer">
      <div className="sidebar-health">
        <SidebarHealthRow status={primaryStatus} label="Codex 主路由" />
        <SidebarHealthRow status={compactStatus} label="Codex 压缩" />
        <SidebarHealthRow status={claudePrimaryStatus} label="Claude 主路由" />
      </div>

      <div className="theme-switch">
        {(["auto", "light", "dark"] as ThemeMode[]).map((mode) => (
          <button
            key={mode}
            className={themeMode === mode ? "is-active" : ""}
            onClick={() => onThemeModeChange(mode)}
          >
            {mode === "auto" ? "自动" : mode === "light" ? "浅色" : "深色"}
          </button>
        ))}
      </div>

      <a className="btn btn-sm btn-ghost" href="/health" style={{ width: "100%", justifyContent: "center" }}>
        健康检查
      </a>
    </div>
  );
}

function SidebarHealthRow({ status, label }: { status: HealthBadge; label: string }) {
  return (
    <div className="sidebar-health-row">
      <span className={`sidebar-health-dot is-${status.tone}`} />
      {label}
    </div>
  );
}
