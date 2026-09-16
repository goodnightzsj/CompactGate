import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from "react";
import type { StudioPage } from "../app-types.js";
import { DashboardPage } from "../dashboard/DashboardPage.js";

const AnalyticsDashboardPage = lazy(() => import("../analytics/AnalyticsDashboardPage.js").then((page) => ({ default: page.AnalyticsDashboardPage })));
const UsageAnalyticsPage = lazy(() => import("../analytics/UsageAnalyticsPage.js").then((page) => ({ default: page.UsageAnalyticsPage })));
const HealthPage = lazy(() => import("../health/HealthPage.js").then((page) => ({ default: page.HealthPage })));
const LogsPage = lazy(() => import("../logs/LogsPage.js").then((page) => ({ default: page.LogsPage })));
const RoutesPage = lazy(() => import("../routes/RoutesPage.js").then((page) => ({ default: page.RoutesPage })));
const ConfigPage = lazy(() => import("../config/ConfigPage.js").then((page) => ({ default: page.ConfigPage })));

export type StudioPageOutletProps = {
  configPage: ComponentProps<typeof ConfigPage>;
  currentPage: StudioPage;
  dashboardPage: ComponentProps<typeof DashboardPage>;
  healthMode: boolean;
  healthPage: ComponentProps<typeof HealthPage>;
  logsPage: ComponentProps<typeof LogsPage>;
  pageError: string | null;
  /** True when the failed refresh left previously loaded data on screen. */
  hasStaleData: boolean;
  onRetry: () => void;
  routesPage: ComponentProps<typeof RoutesPage>;
};

export function StudioPageOutlet({
  configPage,
  currentPage,
  dashboardPage,
  healthMode,
  healthPage,
  logsPage,
  pageError,
  hasStaleData,
  onRetry,
  routesPage
}: StudioPageOutletProps) {
  const content = healthMode ? <HealthPage {...healthPage} /> : (
    <div className={`page-appear ${currentPage === "logs" ? "page-appear-logs" : ""}`}>
      {pageError && (
        <div className="error-banner page-error-banner" role="alert">
          <span>
            {pageError}
            {hasStaleData && " 下面显示的是上次成功加载的数据。"}
          </span>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            重试
          </button>
        </div>
      )}

      {currentPage === "dashboard" && <DashboardPage {...dashboardPage} />}

      {currentPage === "analytics" && <AnalyticsDashboardPage />}

      {currentPage === "usage" && <UsageAnalyticsPage />}

      {currentPage === "routes" && <RoutesPage {...routesPage} />}

      {currentPage === "config" && <ConfigPage {...configPage} />}

      {currentPage === "logs" && <LogsPage {...logsPage} />}
    </div>
  );

  return <PageLoadBoundary key={healthMode ? "health" : currentPage}>{content}</PageLoadBoundary>;
}

// Keep the navigation and draft-owning hooks mounted when a page chunk fails.
class PageLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("Studio page failed to load or render", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="error-banner page-error-banner" role="alert">
          <span>页面加载失败。可以切换到其他页面，或刷新后重试；刷新会丢失未保存的修改。</span>
          <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      );
    }

    return <Suspense fallback={<div className="panel" role="status">正在加载页面…</div>}>{this.props.children}</Suspense>;
  }
}
