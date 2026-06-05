export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatMetricNumber(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return new Intl.NumberFormat("en-US").format(value);
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
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}
