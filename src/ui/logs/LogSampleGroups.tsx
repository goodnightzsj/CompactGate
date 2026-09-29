import { useMemo, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => open ? buildLogSampleGroups(logs) : [], [logs, open]);
  return <details className="log-sample-groups" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>样本分组 · {logs.length} 条{stale ? " · 上次结果" : ""}</summary>
    {open && <>
      <p>仅统计当前筛选已加载的记录，非全库。按上游、凭据标签、通道与目标模型分组；同名凭据无法区分。最近状态从旧到新。</p>
      <ul>{groups.map((group) => <li key={group.key}>
        <span className="log-summary-stack"><strong>{group.host}</strong><small>{group.credential ?? "未记录凭据"} · {routeLabel(group.route)} · {group.model ?? "未知模型"}</small></span>
        <span>{group.count} 次 · {(group.success / group.count * 100).toFixed(1)}% 成功</span>
        <span className="log-recent-pattern" role="img" aria-label={`最近 ${group.recent.length} 次，从旧到新：${[...group.recent].reverse().map((ok) => ok ? "成功" : "失败").join("、")}`}>
          {[...group.recent].reverse().map((ok, index) => <i key={index} className={ok ? "is-ok" : "is-err"} aria-hidden="true" />)}
        </span>
      </li>)}</ul>
    </>}
  </details>;
}
