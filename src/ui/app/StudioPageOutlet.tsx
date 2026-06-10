import type { ComponentProps } from "react";
import type { StudioPage } from "../app-types.js";
import { DashboardPage } from "../dashboard/DashboardPage.js";
import { HealthPage } from "../health/HealthPage.js";
import { LogsPage } from "../logs/LogsPage.js";
import { RoutesPage } from "../routes/RoutesPage.js";
import { ConfigWorkspace, type ConfigWorkspaceProps } from "./ConfigWorkspace.js";

export type StudioPageOutletProps = {
  configPage: ConfigWorkspaceProps;
  currentPage: StudioPage;
  dashboardPage: ComponentProps<typeof DashboardPage>;
  healthMode: boolean;
  healthPage: ComponentProps<typeof HealthPage>;
  logsPage: ComponentProps<typeof LogsPage>;
  pageError: string | null;
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
  routesPage
}: StudioPageOutletProps) {
  if (healthMode) {
    return <HealthPage {...healthPage} />;
  }

  return (
    <>
      {pageError && <div className="error-banner">{pageError}</div>}

      {currentPage === "dashboard" && <DashboardPage {...dashboardPage} />}

      {currentPage === "routes" && <RoutesPage {...routesPage} />}

      {currentPage === "config" && <ConfigWorkspace {...configPage} />}

      {currentPage === "logs" && <LogsPage {...logsPage} />}
    </>
  );
}
