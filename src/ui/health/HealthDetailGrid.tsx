import type { HealthResponse } from "../../shared/types.js";

export function HealthDetailGrid({
  health,
  failedRoutes,
  attentionRoutes
}: {
  health: HealthResponse | null;
  failedRoutes: number;
  attentionRoutes: number;
}) {
  return (
    <section className="health-detail-grid">
      <section className="panel health-notes" aria-labelledby="health-notes-title">
        <div className="section-heading">
          <p className="eyebrow">检查清单</p>
          <h2 id="health-notes-title">如何判断现在能不能接请求</h2>
        </div>

        <div className="health-checklist">
          <div className={`health-check-row is-${health ? "good" : "warn"}`}>
            <span>01</span>
            <p>监听地址可见，说明代理进程已经启动并绑定到本地端口。</p>
          </div>
          <div className={`health-check-row is-${failedRoutes > 0 ? "bad" : "good"}`}>
            <span>02</span>
            <p>上游状态显示“已配置”，说明基础地址格式合法。</p>
          </div>
          <div className={`health-check-row is-${attentionRoutes > 0 ? "warn" : "good"}`}>
            <span>03</span>
            <p>如果显示“缺密钥”，代理仍能启动，但转发前需要先在控制台里直接保存访问密钥，或依赖旧配置里的环境变量回退。</p>
          </div>
        </div>
      </section>

      <section className="panel health-json-panel" aria-labelledby="health-json-title">
        <div className="section-heading">
          <p className="eyebrow">响应内容</p>
          <h2 id="health-json-title">原始健康响应</h2>
        </div>

        <pre className="health-json">
          {health ? JSON.stringify(health, null, 2) : '{\n  "status": "loading"\n}'}
        </pre>
      </section>
    </section>
  );
}
