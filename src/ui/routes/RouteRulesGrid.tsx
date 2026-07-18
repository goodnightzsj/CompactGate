import type { OpenAiCompactionMode, RouteKind } from "../../shared/types.js";

export type RouteHitSource = "preview" | "latest" | "none";

export function RouteRulesGrid({
  listen,
  primaryHost,
  compactHost,
  claudePrimaryHost,
  currentModel,
  compactModel,
  compactMode,
  activeRoute,
  activeCompactionMode,
  activeRouteSource
}: {
  listen: string;
  primaryHost: string;
  compactHost: string;
  claudePrimaryHost: string;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  activeRoute: RouteKind | null;
  activeCompactionMode: OpenAiCompactionMode | null;
  activeRouteSource: RouteHitSource;
}) {
  const compactTarget = compactMode === "split" ? compactHost : primaryHost;
  const activeRemoteV2 = activeRoute === "compact" && activeCompactionMode === "remote_v2";
  const activeRemoteV1 = activeRoute === "compact" &&
    (activeCompactionMode === "remote_v1" || activeCompactionMode === null);
  const activeLocal = activeRoute === "compact" && activeCompactionMode === "local";

  return (
    <div className="routes-layout">
      <div className="route-rule codex">
        <span className="route-chip codex route-rule-kicker">Codex 通道</span>
        <h3>OpenAI 兼容入口</h3>
        <p>请求目标：<code>http://{listen}/v1</code></p>

        <div className="route-mapping">
          <div className={`route-mapping-row ${activeRemoteV1 ? "is-active" : ""}`}>
            <code>/v1/responses/compact</code>
            <span className="tag">Remote V1</span>
            <span className="route-chip compact">压缩上游</span>
            {activeRemoteV1 && <RouteHitMarker source={activeRouteSource} />}
          </div>
          <div className={`route-mapping-row ${activeLocal ? "is-active" : ""}`}>
            <code>/v1/responses + request_kind=compaction</code>
            <span className="tag">Local</span>
            <span className="route-chip compact">压缩上游</span>
            {activeLocal && <RouteHitMarker source={activeRouteSource} />}
          </div>
          <div className={`route-mapping-row ${activeRemoteV2 ? "is-active" : ""}`}>
            <code>/v1/responses + compaction_trigger</code>
            <span className="tag">Remote V2</span>
            <span className="route-chip codex">主上游</span>
            {activeRemoteV2 && <RouteHitMarker source={activeRouteSource} />}
          </div>
          <div className={`route-mapping-row ${activeRoute === "primary" ? "is-active" : ""}`}>
            <code>其它 /v1/*</code>
            <span className="tag">兜底规则</span>
            <span className="route-chip codex">主上游</span>
            {activeRoute === "primary" && <RouteHitMarker source={activeRouteSource} />}
          </div>
        </div>

        <div className="route-slot-info">
          <div className="route-slot">
            <div className="route-slot-label">主路由</div>
            <div className="route-slot-host">{primaryHost}</div>
            <div className="route-slot-hint">普通请求直通</div>
          </div>
          <div className="route-slot">
            <div className="route-slot-label">压缩路由</div>
            <div className="route-slot-host">{compactTarget}</div>
            <div className="route-slot-hint">{compactMode === "split" ? "独立基础地址与密钥" : "复用主路由"}</div>
          </div>
        </div>

        <div className="route-model-strip">
          Local / Remote V1 模型映射：{currentModel} → {compactModel}
        </div>
        <div className="route-note">Remote V2 保留原始模型与 Responses 请求，始终使用 Primary 上游。</div>
      </div>

      <div className="route-rule claude">
        <span className="route-chip claude route-rule-kicker">Claude 通道</span>
        <h3>Anthropic 兼容入口</h3>
        <p>请求目标：<code>http://{listen}/anthropic</code></p>

        <div className="route-mapping">
          <div className={`route-mapping-row ${activeRoute === "claude" ? "is-active" : ""}`}>
            <code>所有 /messages</code>
            <span className="tag">通道规则</span>
            <span className="route-chip claude">主上游</span>
            {activeRoute === "claude" && <RouteHitMarker source={activeRouteSource} />}
          </div>
        </div>

        <div className="route-slot-info">
          <div className="route-slot">
            <div className="route-slot-label">主路由</div>
            <div className="route-slot-host">{claudePrimaryHost}</div>
            <div className="route-slot-hint">普通请求、手动 compact 和重连请求统一走这里</div>
          </div>
        </div>

        <div className="route-note route-note-claude">
          Claude 侧不再按 compact 请求分流；档案切换只切换 Claude 主路由和模型映射。
        </div>
      </div>
    </div>
  );
}

function RouteHitMarker({ source }: { source: RouteHitSource }) {
  if (source === "none") {
    return null;
  }

  return (
    <span className="route-hit-marker">
      {source === "preview" ? "预览命中" : "最近命中"}
    </span>
  );
}
