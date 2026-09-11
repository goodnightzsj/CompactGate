import type { CredentialScope, RouteKind } from "../../shared/types.js";
import type { HealthRouteCredentialConfig } from "../app-types.js";
import {
  activeCredentialLabel,
  credentialFlagCopy,
  credentialSourceLabel,
  upstreamHealthBadge
} from "./health-status.js";

export function HealthEndpointCard({
  title,
  route,
  credentialScope,
  badgeLabel,
  summary,
  upstream
}: {
  title: string;
  route: RouteKind;
  credentialScope: CredentialScope;
  badgeLabel: string;
  summary: string;
  upstream: HealthRouteCredentialConfig | null | undefined;
}) {
  const status = upstreamHealthBadge(upstream);

  return (
    <section className={`panel health-card route-${route} tone-${status.tone}`} aria-label={`${title} 状态`}>
      <div className="health-card-head">
        <div>
          <h2>{title}</h2>
          <p className="eyebrow">{summary}</p>
        </div>
        <span className={`route-chip ${route}`}>{badgeLabel}</span>
      </div>

      <div className="health-card-status">
        <span className={`health-card-led is-${status.tone}`} aria-hidden="true" />
        <strong>{status.label}</strong>
      </div>

      <div className="health-kv">
        <span>Base URL</span>
        <strong>{upstream?.base_url ?? "读取中..."}</strong>
      </div>

      <details className="health-credential-details" open={status.tone !== "good"}>
        <summary>凭据详情 <span>{credentialSourceLabel(upstream?.api_key_source)}</span></summary>
      <div className="health-kv-grid">
        <div className="health-kv">
          <span>密钥来源</span>
          <strong>{credentialSourceLabel(upstream?.api_key_source)}</strong>
        </div>
        <div className="health-kv">
          <span>直填密钥</span>
          <strong>{upstream?.stored_api_key ? "已保存" : "未保存"}</strong>
        </div>
      </div>

      <div className="health-kv is-wide">
        <span>当前读取</span>
        <strong>{activeCredentialLabel(credentialScope, upstream)}</strong>
      </div>

      <div className={`health-flag ${status.tone === "good" ? "is-good" : "is-warn"}`}>
        <span className="health-led" aria-hidden="true" />
        {credentialFlagCopy(credentialScope, upstream)}
      </div>
      </details>
    </section>
  );
}
