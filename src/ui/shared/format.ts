export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Module-level instances: constructing an Intl formatter is the expensive part
// (locale data resolution), and these run per cell on the dashboard's hot path —
// a log-table render built dozens of them. The formatters are stateless, so one
// shared instance per shape is also what the API expects.
const METRIC_NUMBER = new Intl.NumberFormat("en-US");
const COMPACT_METRIC_NUMBER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1
});
const CLOCK_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});
const SHORT_DATE_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

export function formatMetricNumber(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return METRIC_NUMBER.format(value);
}

export function formatCompactMetricNumber(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return COMPACT_METRIC_NUMBER.format(value);
}

export function formatDurationMs(value: number | null): string {
  if (value === null) {
    return "-";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  return `${(value / 1000).toFixed(2)}s`;
}

export function formatClock(iso: string): string {
  return CLOCK_FORMAT.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return DATE_TIME_FORMAT.format(new Date(iso));
}

/**
 * `MM/DD HH:mm` — the same fields the log table shows, minus seconds, for
 * panels where the exact second is noise. Returns the input unchanged when it
 * is not a date, so a malformed upstream value is shown rather than "Invalid
 * Date" (three call sites had each written this guard separately).
 */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return iso;
  }
  return SHORT_DATE_TIME_FORMAT.format(date);
}
