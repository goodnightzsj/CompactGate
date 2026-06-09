import type { HealthResponse } from "../../shared/types.js";
import type { StudioPage, ThemeMode } from "../app-types.js";
import { upstreamHealthBadge } from "../health/health-status.js";
import { StudioSidebarFooter } from "./StudioSidebarFooter.js";

export function StudioSidebar({
  currentPage,
  onNavigate,
  health,
  themeMode,
  onThemeModeChange
}: {
  currentPage: StudioPage;
  onNavigate: (page: StudioPage) => void;
  health: HealthResponse | null;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const primaryStatus = upstreamHealthBadge(health?.primary);
  const compactStatus = upstreamHealthBadge(health?.compact);
  const claudePrimaryStatus = upstreamHealthBadge(health?.claude?.primary);

  const navItems: Array<{ page: StudioPage; label: string; icon: string }> = [
    { page: "dashboard", label: "总览", icon: "◇" },
    { page: "routes", label: "路由", icon: "⇢" },
    { page: "config", label: "配置", icon: "⚙" },
    { page: "logs", label: "日志", icon: "☰" }
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-mark">CG</div>
        <h1>CompactGate</h1>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.page}
            className={`sidebar-nav-item ${currentPage === item.page ? "is-active" : ""}`}
            onClick={() => onNavigate(item.page)}
          >
            <span className="sidebar-nav-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <StudioSidebarFooter
        primaryStatus={primaryStatus}
        compactStatus={compactStatus}
        claudePrimaryStatus={claudePrimaryStatus}
        themeMode={themeMode}
        onThemeModeChange={onThemeModeChange}
      />
    </aside>
  );
}
