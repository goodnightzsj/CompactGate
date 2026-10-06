import { useId, useMemo } from "react";
import type { RequestLogEntry } from "../../shared/types.js";
import { routeLabel } from "../../shared/route-meta.js";
import { logStatusKind } from "./log-utils.js";

export function buildLogSampleGroups(logs: RequestLogEntry[]) {
  const groups = new Map<string, { key: string; host: string; credential: string | null;
    model: string | null; route: RequestLogEntry["route"]; count: number; success: number; recent: boolean[] }>();
  for (const entry of logs) {
    const model = entry.target_model ?? entry.source_model;
    const key = JSON.stringify([entry.upstream_host, entry.key_name, entry.route, model]);
    let group = groups.get(key);
    if (!group) {
      group = { key, host: entry.upstream_host, credential: entry.key_name, model, route: entry.route, count: 0, success: 0, recent: [] };
      groups.set(key, group);
    }
    const success = logStatusKind(entry) === "normal";
    group.count++;
    group.success += Number(success);
    // The log feed is newest-first. Retain only its first ten per group.
    if (group.recent.length < 10) group.recent.push(success);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function LogSampleGroups({ logs, stale }: { logs: RequestLogEntry[]; stale: boolean }) {
  const headingId = useId();
  const descriptionId = useId();
  const groups = useMemo(() => buildLogSampleGroups(logs), [logs]);
  return <section className="log-sample-groups" aria-labelledby={headingId} aria-describedby={descriptionId}>
    <header className="log-sample-heading">
      <h3 id={headingId}>分组明细</h3>
      <p id={descriptionId}>{stale ? "上次结果" : "当前筛选"} · 已加载 {logs.length} 条 · {groups.length} 个分组 · 非全库</p>
    </header>
    <div className="log-sample-list" role="region" aria-label="样本分组明细">
      <ul>{groups.map((group) => {
        const recent = [...group.recent].reverse();
        const failures = group.count - group.success;
        return <li key={group.key}>
          <div className="log-sample-identity">
            <strong>{group.host}</strong>
            <span>{group.model ?? "未知模型"}</span>
          </div>
          <div className="log-sample-source">
            <span>{group.credential ?? "未记录凭据"}</span>
            <small>{routeLabel(group.route)}</small>
          </div>
          <dl className="log-sample-metrics">
            <div><dt>调用</dt><dd>{group.count}</dd></div>
            <div><dt>失败</dt><dd className={failures > 0 ? "is-err" : ""}>{failures}</dd></div>
            <div><dt>成功率</dt><dd>{(group.success / group.count * 100).toFixed(1)}%</dd></div>
          </dl>
          <div className="log-sample-recent">
            <small>最近 {recent.length} 次 · 旧 → 新</small>
            <span className="log-recent-pattern" role="img" aria-label={`最近 ${recent.length} 次，从旧到新：${recent.map((ok) => ok ? "成功" : "失败").join("、")}`}>
              {recent.map((ok, index) => <i key={index} className={ok ? "is-ok" : "is-err"} aria-hidden="true" />)}
            </span>
          </div>
        </li>;
      })}</ul>
    </div>
    <p className="log-sample-note">按上游、凭据标签、通道与模型分组；模型优先取目标模型。同名凭据无法区分，以上不代表上游健康状态。</p>
  </section>;
}
