import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { inputDate, parseInputDate } from "./analytics-data.js";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const MAX_RANGE_DAYS = 31;

interface DatePreset {
  label: string;
  range: () => { from: string; to: string };
}

const PRESETS: DatePreset[] = [
  { label: "今天", range: () => recentDays(1) },
  { label: "昨天", range: yesterday },
  { label: "近 7 天", range: () => recentDays(7) },
  { label: "近 30 天", range: () => recentDays(30) }
];

export function DateRangePicker({
  from,
  to,
  onApply
}: {
  from: string;
  to: string;
  onApply: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(to));
  const [focusedDate, setFocusedDate] = useState(to);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const calendarDays = useMemo(() => monthGrid(visibleMonth), [visibleMonth]);
  const today = inputDate(new Date());

  useEffect(() => {
    if (!open) {
      setDraftFrom(from);
      setDraftTo(to);
      setSelectingEnd(false);
    }
  }, [from, open, to]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLButtonElement>(`[data-calendar-date="${focusedDate}"]`)
        ?.focus();
    });
  }, [focusedDate, open, visibleMonth]);

  function showPicker() {
    setDraftFrom(from);
    setDraftTo(to);
    setVisibleMonth(monthStart(to));
    setFocusedDate(to);
    setSelectingEnd(false);
    setOpen(true);
  }

  function chooseDate(value: string) {
    if (selectingEnd) {
      if (parseInputDate(value) < parseInputDate(draftFrom)) {
        setDraftFrom(value);
        setDraftTo(value);
        setFocusedDate(value);
        setVisibleMonth(monthStart(value));
        return;
      }
      if (parseInputDate(value) > addDays(draftFrom, MAX_RANGE_DAYS - 1)) {
        return;
      }
      setDraftTo(value);
      setSelectingEnd(false);
    } else {
      setDraftFrom(value);
      setDraftTo(value);
      setSelectingEnd(true);
    }
    setFocusedDate(value);
    setVisibleMonth(monthStart(value));
  }

  function selectPreset(preset: DatePreset) {
    const range = preset.range();
    setDraftFrom(range.from);
    setDraftTo(range.to);
    setFocusedDate(range.to);
    setVisibleMonth(monthStart(range.to));
    setSelectingEnd(false);
  }

  function apply() {
    onApply(draftFrom, draftTo);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function moveFocus(days: number) {
    const next = inputDate(addDays(focusedDate, days));
    setFocusedDate(next);
    setVisibleMonth(monthStart(next));
  }

  function moveMonth(months: number) {
    const next = shiftMonth(focusedDate, months);
    setFocusedDate(next);
    setVisibleMonth(monthStart(next));
  }

  function handleDayKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7
    };
    if (event.key in moves) {
      event.preventDefault();
      moveFocus(moves[event.key]);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const weekday = (parseInputDate(focusedDate).getDay() + 6) % 7;
      moveFocus(event.key === "Home" ? -weekday : 6 - weekday);
      return;
    }
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      moveMonth(event.key === "PageUp" ? -1 : 1);
    }
  }

  return (
    <div className="usage-date-picker" ref={rootRef}>
      <span className="usage-date-picker-label">日期范围</span>
      <button
        ref={triggerRef}
        type="button"
        className="usage-date-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => open ? setOpen(false) : showPicker()}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
            event.preventDefault();
            showPicker();
          }
        }}
      >
        <CalendarIcon />
        <span>{formatRange(from, to)}</span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div id={panelId} className="usage-date-popover" role="dialog" aria-label="选择日期范围">
          <div className="usage-date-presets" aria-label="快捷日期范围">
            {PRESETS.map((preset) => {
              const range = preset.range();
              const active = range.from === draftFrom && range.to === draftTo;
              return (
                <button
                  key={preset.label}
                  type="button"
                  className={active ? "is-active" : ""}
                  aria-pressed={active}
                  onClick={() => selectPreset(preset)}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div className="usage-date-summary" aria-live="polite">
            <span><small>开始</small>{formatDay(draftFrom)}</span>
            <span aria-hidden="true">→</span>
            <span><small>结束</small>{formatDay(draftTo)}</span>
          </div>

          <div className="usage-calendar-head">
            <button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}>‹</button>
            <strong>{formatMonth(visibleMonth)}</strong>
            <button type="button" aria-label="下个月" onClick={() => moveMonth(1)}>›</button>
          </div>

          <div className="usage-calendar" role="grid" aria-label={formatMonth(visibleMonth)}>
            {WEEKDAYS.map((weekday) => (
              <span key={weekday} className="usage-calendar-weekday" role="columnheader">{weekday}</span>
            ))}
            {calendarDays.map((value) => {
              const outside = monthStart(value) !== visibleMonth;
              const inRange = value >= draftFrom && value <= draftTo;
              const boundary = value === draftFrom || value === draftTo;
              const disabled = selectingEnd && parseInputDate(value) > addDays(draftFrom, MAX_RANGE_DAYS - 1);
              return (
                <span key={value} className="usage-calendar-cell" role="gridcell" aria-selected={inRange}>
                  <button
                    type="button"
                    data-calendar-date={value}
                    className={[
                      outside && "is-outside",
                      inRange && "is-in-range",
                      boundary && "is-boundary",
                      value === today && "is-today",
                      disabled && "is-disabled"
                    ].filter(Boolean).join(" ")}
                    aria-label={formatAccessibleDay(value)}
                    aria-disabled={disabled}
                    tabIndex={value === focusedDate ? 0 : -1}
                    onClick={() => chooseDate(value)}
                    onKeyDown={handleDayKeyDown}
                  >
                    {parseInputDate(value).getDate()}
                  </button>
                </span>
              );
            })}
          </div>

          <div className="usage-date-actions">
            <small>{selectingEnd ? "选择结束日期，最多 31 天" : "最多选择 31 天"}</small>
            <button type="button" className="btn btn-primary btn-sm" onClick={apply}>应用</button>
          </div>
        </div>
      )}
    </div>
  );
}

function recentDays(days: number): { from: string; to: string } {
  const to = inputDate(new Date());
  return { from: inputDate(addDays(to, 1 - days)), to };
}

function yesterday(): { from: string; to: string } {
  const value = inputDate(addDays(inputDate(new Date()), -1));
  return { from: value, to: value };
}

function addDays(value: string, days: number): Date {
  const date = parseInputDate(value);
  date.setDate(date.getDate() + days);
  return date;
}

function monthStart(value: string): string {
  const date = parseInputDate(value);
  return inputDate(new Date(date.getFullYear(), date.getMonth(), 1));
}

function shiftMonth(value: string, offset: number): string {
  const date = parseInputDate(value);
  const first = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return inputDate(new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), lastDay)));
}

function monthGrid(value: string): string[] {
  const first = parseInputDate(value);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(start.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => inputDate(addDays(inputDate(start), index)));
}

function formatRange(from: string, to: string): string {
  const start = parseInputDate(from);
  const end = parseInputDate(to);
  const startLabel = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(start);
  const endLabel = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  }).format(end);
  return `${startLabel} - ${endLabel}`;
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(parseInputDate(value));
}

function formatMonth(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(parseInputDate(value));
}

function formatAccessibleDay(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(parseInputDate(value));
}

function CalendarIcon() {
  return (
    <svg className="usage-date-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3v3M17 3v3M4.5 9h15M6 5h12a2 2 0 0 1 2 2v12H4V7a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`usage-date-chevron ${open ? "is-open" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}
