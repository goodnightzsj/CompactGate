import { useId, useState, type DragEvent } from "react";
import { DIRECT_API_KEY_ID, isApiKeyPriority, MAX_API_KEY_PRIORITY } from "../../shared/api-key-priority.js";
import type { PrimaryKeyStrategy } from "../../shared/types.js";
import { CustomSelect } from "../shared/CustomSelect.js";
import { Field } from "./Field.js";
import { moveKeyInOrder, orderedKeys, type KeyPriorityEntry } from "./key-pool-order.js";
import type { FormKeyPoolEntry } from "./types.js";

export function ApiKeyPoolEditor({
  title, direct, entries, strategy, rotationEnabled, rotationOptOut, stickyReserveSeconds,
  activity, onEntriesChange, onDirectPriorityChange, onStrategyChange, onRotationOptOutChange,
  onStickyReserveChange
}: {
  title: string;
  direct: { configured: boolean; tail: string; priority: number | "" };
  entries: FormKeyPoolEntry[];
  strategy: PrimaryKeyStrategy;
  rotationEnabled: boolean;
  rotationOptOut: boolean;
  stickyReserveSeconds: number;
  activity?: { key_id: string; used_at: string };
  onEntriesChange: (entries: FormKeyPoolEntry[]) => void;
  onDirectPriorityChange: (priority: number | "") => void;
  onStrategyChange: (strategy: PrimaryKeyStrategy) => void;
  onRotationOptOutChange: (value: boolean) => void;
  onStickyReserveChange: (seconds: number) => void;
}) {
  const editorId = useId();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const [undoPriorities, setUndoPriorities] = useState<KeyPriorityEntry[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const rows = orderedKeys([
    ...(direct.configured ? [{ id: DIRECT_API_KEY_ID, label: "访问密钥", priority: direct.priority,
      tail: direct.tail, apiKey: "", enabled: true }] : []),
    ...entries
  ]);
  const eligible = rows.filter((entry) => entry.enabled && (entry.id === DIRECT_API_KEY_ID || entry.apiKey.trim() || entry.tail));
  const validPriorities = rows.every((entry) => isApiKeyPriority(Number(entry.priority)));
  const canReorder = strategy === "fill_first" && validPriorities && rows.length > 1 && rows.length <= MAX_API_KEY_PRIORITY + 1;
  const firstPriority = eligible[0]?.priority;
  const rotationOn = rotationEnabled && !rotationOptOut;

  function updateEntry(id: string, patch: Partial<Omit<FormKeyPoolEntry, "id" | "tail">>) {
    onEntriesChange(entries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  function applyPriorities(priorities: KeyPriorityEntry[]) {
    const byId = new Map(priorities.map((entry) => [entry.id, entry.priority]));
    if (byId.has(DIRECT_API_KEY_ID)) onDirectPriorityChange(byId.get(DIRECT_API_KEY_ID)!);
    onEntriesChange(entries.map((entry) => byId.has(entry.id)
      ? { ...entry, priority: byId.get(entry.id)! } : entry));
  }

  function move(id: string, target: string, position: "before" | "after") {
    if (!canReorder) return;
    const next = moveKeyInOrder(rows, id, target, position);
    if (!next) return;
    setUndoPriorities((previous) => previous ?? rows.map(({ id: keyId, priority }) => ({ id: keyId, priority })));
    applyPriorities(next);
    setAnnouncement(`${rows.find((row) => row.id === id)?.label || "密钥"} 已移至第 ${next.findIndex((row) => row.id === id) + 1} 位。保存后生效。`);
  }

  function dropPosition(event: DragEvent<HTMLElement>): "before" | "after" {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  }

  return <section className="key-pool-editor" aria-label={`${title} 密钥池`}>
    <div className="key-order-heading">
      <div><h5>API Key 使用顺序</h5><p>同一档案内，从上到下优先使用；不可用时跳过。</p></div>
      <span className="route-chip primary">{eligible.length} 把候选</span>
    </div>
    <div className="key-order-policy">
      <CustomSelect label="轮转策略" value={strategy} options={[
        { value: "fill_first", label: "故障转移（按顺序使用）", meta: "首选不可用时，后续请求使用下一把" },
        { value: "spread", label: "分摊（同级分配）", meta: "最高可用优先级内分摊新会话" }
      ]} onChange={(value) => onStrategyChange(value as PrimaryKeyStrategy)} />
      <p className="key-order-policy-note">
        {rotationOn
          ? "池内自动调度已开启。已有会话优先沿用原 key；失败请求不会立即换 key 重发。"
          : "池内自动调度未开启：按固定选择使用，不会因故障自动换 key。"}
        {strategy === "spread" && " 调整先后顺序请先切换到故障转移；同级分摊可在展开项中设置优先级。"}
      </p>
    </div>
    <div className="key-order-caption"><span>拖动或使用移动按钮调整</span><span>草稿 · 保存后生效</span></div>
    {!validPriorities && <p role="alert" className="error-note">请先修正展开项中的优先级，再调整顺序。</p>}
    {rows.length === 0 ? <p className="key-pool-empty">在上方填写访问密钥，或添加第一把池内密钥。</p>
      : <ol className="key-order-list" aria-label={`${title} 密钥使用顺序`}>
        {rows.map((entry, index) => {
          const isDirect = entry.id === DIRECT_API_KEY_ID;
          const available = entry.enabled && Boolean(isDirect || entry.apiKey.trim() || entry.tail);
          const label = entry.label.trim() || `密钥 ${index + 1}`;
          const expanded = expandedId === entry.id;
          const active = activity?.key_id === entry.id && !entry.apiKey.trim();
          const tail = entry.apiKey.trim().slice(-4) || entry.tail;
          const preferred = available && (strategy === "spread"
            ? Number(entry.priority) === Number(firstPriority) : entry.id === eligible[0]?.id);
          return <li key={entry.id} data-key-id={entry.id}
            className={`key-order-row${!available ? " is-disabled" : ""}${active ? " is-active" : ""}${draggedId === entry.id ? " is-dragging" : ""}`}
            data-drop-position={dropTarget?.id === entry.id ? dropTarget.position : undefined}
            onDragOver={(event) => {
              if (!draggedId || !canReorder) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTarget(draggedId === entry.id ? null : { id: entry.id, position: dropPosition(event) });
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedId) move(draggedId, entry.id, dropPosition(event));
              setDraggedId(null); setDropTarget(null);
            }}>
            <button type="button" className="key-order-handle" draggable={canReorder} disabled={!canReorder}
              aria-label={`拖动 ${label} 调整顺序`} title="拖动调整顺序，也可使用右侧移动按钮"
              onDragStart={(event) => {
                if (!canReorder) { event.preventDefault(); return; }
                setDraggedId(entry.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", entry.id);
              }} onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}><span aria-hidden="true">⠿</span></button>
            <span className="key-order-rank" aria-label={`第 ${index + 1} 位`}>{String(index + 1).padStart(2, "0")}</span>
            <button type="button" className="key-order-identity" aria-expanded={expanded}
              aria-controls={`${editorId}-${entry.id}`} onClick={() => setExpandedId(expanded ? null : entry.id)}>
              <strong title={label}>{label}<span className="key-order-expand" aria-hidden="true">{expanded ? "−" : "+"}</span></strong>
              <span className="key-order-meta">{tail && <code>…{tail}</code>}{isDirect && <span>直填</span>}
                {!entry.enabled ? <span>已停用</span> : !available ? <span>未填写 · 不参与</span> : preferred ? <span className="key-order-preferred">首选</span> : <span>备用</span>}
                {active && <span className="key-order-active" title={`最近选用：${activity.used_at}；不代表所有会话或当前健康`}>Active · 最近选用</span>}
              </span>
            </button>
            <div className="key-order-actions" role="group" aria-label={`${label} 排序操作`}>
              <button type="button" disabled={!canReorder || index === 0} aria-label={`上移 ${label}`} title="上移" onClick={() => move(entry.id, rows[index - 1].id, "before")}>↑</button>
              <button type="button" disabled={!canReorder || index === rows.length - 1} aria-label={`下移 ${label}`} title="下移" onClick={() => move(entry.id, rows[index + 1].id, "after")}>↓</button>
              <button type="button" disabled={!canReorder || index === 0} aria-label={`置顶 ${label}`} onClick={() => move(entry.id, rows[0].id, "before")}>置顶</button>
            </div>
            <div className="key-order-edit" id={`${editorId}-${entry.id}`} hidden={!expanded}>
              {!isDirect && <>
                <label className="key-pool-label-field"><span>标签</span><input className="key-pool-label-input"
                  aria-label={`${label} 标签`} value={entry.label} onChange={(event) => updateEntry(entry.id, { label: event.target.value })} /></label>
                <label className="key-pool-secret-field"><span>替换密钥</span><input type="password" autoComplete="off" spellCheck={false}
                  aria-label={`${label} 密钥值`} value={entry.apiKey} placeholder={entry.tail ? "留空保持已保存密钥" : "填写密钥"}
                  onChange={(event) => updateEntry(entry.id, { apiKey: event.target.value })} /></label>
              </>}
              <KeyPriorityField label={isDirect ? `${title} 直填密钥优先级` : `${title} ${label} 优先级`} value={entry.priority}
                onChange={(value) => isDirect ? onDirectPriorityChange(value) : updateEntry(entry.id, { priority: value })} />
              {isDirect ? <p>在上方「访问密钥」修改密钥值。</p> : <div className="key-order-edit-actions">
                <label className="key-pool-toggle"><input type="checkbox" checked={entry.enabled} onChange={(event) => updateEntry(entry.id, { enabled: event.target.checked })} />
                  <span className="key-pool-track" aria-hidden="true"><span className="key-pool-thumb" /></span><span>启用</span></label>
                <button type="button" className="field-inline-button is-danger" onClick={() => {
                  if (!entry.tail || pendingDeleteId === entry.id) {
                    onEntriesChange(entries.filter((item) => item.id !== entry.id)); setPendingDeleteId(null);
                  } else setPendingDeleteId(entry.id);
                }} onBlur={() => setPendingDeleteId(null)}>{pendingDeleteId === entry.id ? "确认删除" : "删除密钥"}</button>
              </div>}
            </div>
          </li>;
        })}
      </ol>}
    <div className="key-order-footer">
      <button className="ghost-button" type="button" onClick={() => {
        const entry = { id: crypto.randomUUID(), label: "", apiKey: "", enabled: true, priority: 0, tail: "" };
        onEntriesChange([...entries, entry]); setExpandedId(entry.id);
      }}>＋ 添加密钥</button>
      {undoPriorities && <button className="field-inline-button" type="button" onClick={() => {
        applyPriorities(undoPriorities); setUndoPriorities(null); setAnnouncement("已撤销排序，其他编辑保持不变。");
      }}>撤销排序</button>}
    </div>
    <p className="key-order-observation">{activity ? "Active 表示本档案最近请求选用的已保存 key，不代表实时健康；分摊或旧会话可能使用其他 key。" : "本次连接尚未观察到本档案的 key 使用记录；首选不代表正在使用。"}</p>
    <span className="key-order-announcement" role="status" aria-live="polite">{announcement}</span>
    <details className="key-order-advanced"><summary>高级设置</summary>
      <p>优先级 0–{MAX_API_KEY_PRIORITY}，越大越优先；拖动会自动生成严格顺序。单把数字可在展开项中调整。</p>
      <Field label="粘性保留带宽（秒）" hint="429 冷却结束后只接原会话的时长；0 关闭。">
        <input type="number" min={0} max={86400} value={stickyReserveSeconds} onChange={(event) => onStickyReserveChange(Number(event.target.value))} />
      </Field>
      <label className="key-pool-policy-toggle"><input type="checkbox" checked={rotationOptOut} onChange={(event) => onRotationOptOutChange(event.target.checked)} />
        <span className="key-pool-track" aria-hidden="true"><span className="key-pool-thumb" /></span><span>不参与自动轮转</span></label>
    </details>
  </section>;
}

function KeyPriorityField({ label, value, onChange }: { label: string; value: number | ""; onChange: (value: number | "") => void }) {
  const id = useId();
  const [blurred, setBlurred] = useState(false);
  const invalid = blurred && !isApiKeyPriority(Number(value));
  return <label className="key-pool-priority-field"><span>优先级</span>
    <input aria-label={label} type="number" inputMode="numeric" min={0} max={MAX_API_KEY_PRIORITY} step={1}
      placeholder="0" value={Number.isNaN(value) ? "" : value} aria-invalid={invalid || undefined}
      aria-describedby={invalid ? id : undefined} onBlur={() => setBlurred(true)}
      onChange={(event) => onChange(event.target.validity.badInput ? Number.NaN : event.target.value === "" ? "" : event.target.valueAsNumber)} />
    {invalid && <small id={id} className="key-priority-error" role="alert">须为 0–{MAX_API_KEY_PRIORITY} 的整数</small>}
  </label>;
}
