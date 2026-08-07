import type { ReactNode } from "react";
import type { HealthResponse } from "../../shared/types.js";
import type { StudioPage, ThemeMode } from "../app-types.js";
import { upstreamHealthBadge } from "../health/health-status.js";
import { StudioSidebarFooter } from "./StudioSidebarFooter.js";

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true
};

function IconDashboard() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

function IconAnalytics() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.5 13.5h11" />
      <path d="M3.5 11V8.5M7 11V4.5M10.5 11V6.5M14 11V2.5" />
    </svg>
  );
}

function IconUsage() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.5 12.5 5.8 9l2.5 1.8 5.2-6.3" />
      <circle cx="5.8" cy="9" r="0.8" />
      <circle cx="8.3" cy="10.8" r="0.8" />
      <circle cx="13.5" cy="4.5" r="0.8" />
    </svg>
  );
}

function IconRoutes() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2.5 4.5h7a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h0" />
      <path d="M2.5 4.5h-1" />
      <circle cx="2.5" cy="4.5" r="1" />
      <path d="M13.5 4.5h-1" />
      <path d="M2.5 11.5h7a2 2 0 0 0 2-2v-3a2 2 0 0 1 2-2h0" />
      <circle cx="13.5" cy="4.5" r="1" />
      <path d="M13.5 11.5h-1" />
      <circle cx="13.5" cy="11.5" r="1" />
      <circle cx="2.5" cy="11.5" r="1" />
    </svg>
  );
}

function IconConfig() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4" />
    </svg>
  );
}

function IconLogs() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5Z" />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </svg>
  );
}

function IconHealth() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M8 2.8 9.4 4.2M9.4 4.2l1.4-1.4M9.4 4.2v0" />
      <path d="M8 13.5a5 5 0 0 0 5-5H3a5 5 0 0 0 5 5Z" />
      <path d="M8 3a4 4 0 0 1 4 4H4a4 4 0 0 1 4-4Z" />
      <path d="M3 8.5h10" />
    </svg>
  );
}

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

  const navItems: Array<{ page: StudioPage; label: string; icon: ReactNode }> = [
    { page: "dashboard", label: "总览", icon: <IconDashboard /> },
    { page: "analytics", label: "仪表盘", icon: <IconAnalytics /> },
    { page: "usage", label: "用量", icon: <IconUsage /> },
    { page: "routes", label: "路由", icon: <IconRoutes /> },
    { page: "config", label: "配置", icon: <IconConfig /> },
    { page: "logs", label: "日志", icon: <IconLogs /> },
    { page: "health", label: "健康", icon: <IconHealth /> }
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
            aria-current={currentPage === item.page ? "page" : undefined}
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
