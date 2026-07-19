import type { CodexVersionStatus } from "../../shared/types.js";
import { compactionModeClass, compactionModeLabel } from "../logs/log-utils.js";

export function CodexProtocolStatus({ status }: { status: CodexVersionStatus | null }) {
  const client = status?.protocol_source === "request"
    ? status.observed_clients[0] ?? null
    : status?.local_client ?? null;
  const protocolLabel = status ? protocolStatusLabel(status.observed_protocol) : "读取中";
  const protocolClass = status?.observed_protocol === "mixed"
    ? "mixed"
    : status?.observed_protocol ?? "unknown";
  const sourceLabel = status ? protocolSourceLabel(status.protocol_source) : "等待状态";

  return (
    <section className="protocol-status-panel" aria-labelledby="codex-protocol-status-title">
      <div className="protocol-status-head">
        <div>
          <p className="eyebrow">Codex 压缩协议</p>
          <h3 id="codex-protocol-status-title">{protocolLabel}</h3>
          <p className="protocol-status-subtitle">实际请求优先，版本信息只作为未观测时的基线推断。</p>
        </div>
        <span className={`protocol-chip ${protocolClass}`}>{sourceLabel}</span>
      </div>

      <div className="protocol-status-metrics">
        <div>
          <span>客户端</span>
          <strong>{client ? `${client.name} ${client.raw_version}` : "未探测"}</strong>
          {client?.is_fork && <small>二开变体 · 基线 {client.base_version ?? "未知"}</small>}
        </div>
        <div>
          <span>V2 默认起点</span>
          <strong>{status?.v2_default_from ?? "0.140.0"}</strong>
          <small>{status?.last_checked_at ? `探测于 ${formatStatusTime(status.last_checked_at)}` : "等待本机 CLI 探测"}</small>
        </div>
        <div>
          <span>最近观测</span>
          <strong>{status?.observed_at ? formatStatusTime(status.observed_at) : "暂无压缩请求"}</strong>
          <small>{status?.confidence === "observed" ? "来自真实请求日志" : "尚未获得真实协议证据"}</small>
        </div>
      </div>

      <div className="protocol-comparison" aria-label="压缩协议对比">
        <ProtocolRow mode="remote_v1" trigger="/responses/compact" destination="独立 compact 上游" />
        <ProtocolRow mode="remote_v2" trigger="/responses + compaction_trigger" destination="Primary Responses 上游" />
        <ProtocolRow mode="local" trigger="request_kind=compaction" destination="compact 策略" />
      </div>
    </section>
  );
}

function ProtocolRow({
  mode,
  trigger,
  destination
}: {
  mode: "remote_v1" | "remote_v2" | "local";
  trigger: string;
  destination: string;
}) {
  return (
    <div className="protocol-comparison-row">
      <span className={`protocol-chip ${compactionModeClass(mode)}`}>{compactionModeLabel(mode)}</span>
      <code>{trigger}</code>
      <span>{destination}</span>
    </div>
  );
}

function protocolStatusLabel(protocol: CodexVersionStatus["observed_protocol"]): string {
  switch (protocol) {
    case "remote_v1":
      return "Remote V1";
    case "remote_v2":
      return "Remote V2";
    case "local":
      return "Local 压缩";
    case "mixed":
      return "V1 + V2 混合";
    default:
      return "协议未观测";
  }
}

function protocolSourceLabel(source: CodexVersionStatus["protocol_source"]): string {
  if (source === "request") {
    return "实际观测";
  }
  if (source === "version_baseline") {
    return "版本基线推断";
  }
  return "未观测";
}

function formatStatusTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
