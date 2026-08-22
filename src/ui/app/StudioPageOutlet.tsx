import type { ComponentProps } from "react";
import type { StudioPage } from "../app-types.js";
import { AnalyticsDashboardPage } from "../analytics/AnalyticsDashboardPage.js";
import { UsageAnalyticsPage } from "../analytics/UsageAnalyticsPage.js";
import { DashboardPage } from "../dashboard/DashboardPage.js";
import { HealthPage } from "../health/HealthPage.js";
import { LogsPage } from "../logs/LogsPage.js";
import { RoutesPage } from "../routes/RoutesPage.js";
import { ConfigPage } from "../config/ConfigPage.js";

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
  if (healthMode) {
    return <HealthPage {...healthPage} />;
  }

  return (
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
}
