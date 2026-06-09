import type { HealthResponse } from "../../shared/types.js";
import { HealthDetailGrid } from "./HealthDetailGrid.js";
import { HealthEndpointCard } from "./HealthEndpointCard.js";
import { HealthHeroSection } from "./HealthHeroSection.js";
import {
  overallHealthBadge,
  StatusPill,
  upstreamHealthBadge
} from "./health-status.js";

export function HealthPage({
  health,
  error,
  isRefreshing,
  onRefresh
}: {
  health: HealthResponse | null;
  error: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const primaryStatus = upstreamHealthBadge(health?.primary);
  const compactStatus = upstreamHealthBadge(health?.compact);
  const claudePrimaryStatus = upstreamHealthBadge(health?.claude.primary);
  const overallStatus = overallHealthBadge(health);
  const routeStatuses = [
    { label: "Codex 主路由", status: primaryStatus },
    { label: "Codex 压缩", status: compactStatus },
    { label: "Claude 主路由", status: claudePrimaryStatus }
  ];
  const readyRoutes = routeStatuses.filter((item) => item.status.tone === "good").length;
  const attentionRoutes = routeStatuses.filter((item) => item.status.tone === "warn").length;
  const failedRoutes = routeStatuses.filter((item) => item.status.tone === "bad").length;
  const listenUrl = health ? `http://${health.listen}` : "读取中...";
  const openAiEndpoint = health ? `http://${health.listen}/v1` : "等待健康数据";
  const claudeEndpoint = health ? `http://${health.listen}/anthropic` : "等待健康数据";

  return (
    <main className="shell shell-health">
      <header className="topbar health-topbar">
        <div className="brand-lockup">
          <div className="mark" aria-hidden="true">
            CG
          </div>
          <div>
            <p className="eyebrow">CompactGate 健康检查</p>
            <h1>健康检查与上游装配状态</h1>
          </div>
        </div>

        <div className="status-strip" aria-label="CompactGate 健康状态">
          <StatusPill label="总体状态" status={overallStatus} />
          <StatusPill label="主上游" status={primaryStatus} />
          <StatusPill label="压缩上游" status={compactStatus} />
          <StatusPill label="Claude" status={claudePrimaryStatus} />
        </div>

        <div className="toolbar">
          <a className="ghost-button" href="/">
            返回控制台
          </a>
          <a className="ghost-button" href="/api/health" target="_blank" rel="noreferrer">
            原始 JSON
          </a>
          <button className="solid-button" type="button" onClick={onRefresh} disabled={isRefreshing}>
            {isRefreshing ? "刷新中..." : "刷新状态"}
          </button>
        </div>
      </header>

      {error && <p className="error-banner">{error}</p>}

      <HealthHeroSection
        overallStatus={overallStatus}
        readyRoutes={readyRoutes}
        attentionRoutes={attentionRoutes}
        failedRoutes={failedRoutes}
        listenUrl={listenUrl}
        refreshedAt={health?.time ?? null}
        isRefreshing={isRefreshing}
      />

      <section className="health-entry-grid" aria-label="代理入口">
        <div className="health-entry-card">
          <span>OpenAI 兼容入口</span>
          <code>{openAiEndpoint}</code>
          <small>Codex 普通请求和 compact 请求都从这里进入。</small>
        </div>
        <div className="health-entry-card is-claude">
          <span>Anthropic 兼容入口</span>
          <code>{claudeEndpoint}</code>
          <small>所有 Claude Messages 请求使用这个入口。</small>
        </div>
      </section>

      <section className="health-grid">
        <HealthEndpointCard
          title="Codex 主路由"
          route="primary"
          credentialScope="primary"
          badgeLabel="Codex 主"
          summary="处理普通 OpenAI 兼容 /v1 请求"
          upstream={health?.primary}
        />
        <HealthEndpointCard
          title="Codex 压缩路由"
          route="compact"
          credentialScope="compact"
          badgeLabel="Codex 压缩"
          summary="处理 /v1/responses/compact"
          upstream={health?.compact}
        />
        <HealthEndpointCard
          title="Claude 主路由"
          route="claude"
          credentialScope="claude_primary"
          badgeLabel="Claude 主"
          summary="处理所有 Anthropic Messages 请求"
          upstream={health?.claude.primary}
        />
      </section>

      <HealthDetailGrid
        health={health}
        failedRoutes={failedRoutes}
        attentionRoutes={attentionRoutes}
      />
    </main>
  );
}
