import type { RouteKind } from "../../shared/types.js";

export function RouteRulesGrid({
  listen,
  primaryHost,
  compactHost,
  claudePrimaryHost,
  currentModel,
  compactModel,
  compactMode,
  activeRoute
}: {
  listen: string;
  primaryHost: string;
  compactHost: string;
  claudePrimaryHost: string;
  currentModel: string;
  compactModel: string;
  compactMode: "split" | "primary";
  activeRoute: RouteKind;
}) {
  const compactTarget = compactMode === "split" ? compactHost : primaryHost;

  return (
    <div className="routes-layout">
      <div className="route-rule codex">
        <span className="route-chip codex" style={{ marginBottom: 8 }}>Codex 通道</span>
        <h3>OpenAI 兼容入口</h3>
        <p>请求目标：<code>http://{listen}/v1</code></p>

        <div className="route-mapping">
          <div className={`route-mapping-row ${activeRoute === "compact" ? "is-active" : ""}`}>
            <code>/v1/responses/compact</code>
            <span className="tag">命中</span>
            <span className="route-chip compact">压缩上游</span>
          </div>
          <div className={`route-mapping-row ${activeRoute === "primary" ? "is-active" : ""}`}>
            <code>其它 /v1/*</code>
            <span className="tag">默认</span>
            <span className="route-chip codex">主上游</span>
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

        <div className="route-model-strip" style={{ marginTop: 14, padding: "8px 12px", background: "var(--paper-warm)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-mono)", fontSize: "0.78rem", color: "var(--ink)" }}>
          模型映射：{currentModel} → {compactModel}
        </div>
      </div>

      <div className="route-rule claude">
        <span className="route-chip claude" style={{ marginBottom: 8 }}>Claude 通道</span>
        <h3>Anthropic 兼容入口</h3>
        <p>请求目标：<code>http://{listen}/anthropic</code></p>

        <div className="route-mapping">
          <div className={`route-mapping-row ${activeRoute === "claude" ? "is-active" : ""}`}>
            <code>所有 /messages</code>
            <span className="tag">默认</span>
            <span className="route-chip claude">主上游</span>
          </div>
        </div>

        <div className="route-slot-info">
          <div className="route-slot">
            <div className="route-slot-label">主路由</div>
            <div className="route-slot-host">{claudePrimaryHost}</div>
            <div className="route-slot-hint">普通请求、手动 compact 和重连请求统一走这里</div>
          </div>
        </div>

        <div style={{ marginTop: 14, padding: "10px 12px", background: "var(--jade-soft)", borderRadius: "var(--radius-sm)", fontSize: "0.76rem", color: "var(--muted)", lineHeight: 1.6 }}>
          Claude 侧不再按 compact 请求分流；档案切换只切换 Claude 主路由和模型映射。
        </div>
      </div>
    </div>
  );
}
