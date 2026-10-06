import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardStatsGrid } from "../src/ui/dashboard/DashboardStatsGrid.js";
import { DashboardPage } from "../src/ui/dashboard/DashboardPage.js";
import { HealthPage } from "../src/ui/health/HealthPage.js";

describe("unavailable studio snapshots", () => {
  it("does not claim a default configuration or offer export before config loads", () => {
    const markup = renderToStaticMarkup(<DashboardPage config={null} health={null} logs={[]} logCounts={null}
      logError={null} saveState="idle" hasPendingChanges={false} onRetryLogs={() => undefined}
      onExport={() => undefined} onNavigate={() => undefined} />);
    expect(markup).not.toContain("使用默认配置");
    expect(markup).not.toContain("http://127.0.0.1:7865");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>导出配置/);
  });
  it("does not count unknown routes as unhealthy on the dashboard", () => {
    const markup = renderToStaticMarkup(<DashboardStatsGrid health={null} listen="127.0.0.1:7865" logCounts={null} />);
    expect(markup).not.toContain("3 条路由需要关注");
    expect(markup).not.toContain("0/3");
    expect(markup).toContain("等待健康数据");
  });

  it("does not claim missing credentials or zero readiness before a health snapshot", () => {
    const markup = renderToStaticMarkup(<HealthPage health={null} error={null} isRefreshing={false}
      onRefresh={() => undefined} onConfigure={() => undefined} />);
    expect(markup).not.toContain("当前没有可用密钥");
    expect(markup).not.toContain("未保存");
    expect(markup).not.toContain("0/3");
    expect(markup).not.toContain("3 条需要补全");
    expect(markup).toContain("等待首次健康采样");
  });
});
