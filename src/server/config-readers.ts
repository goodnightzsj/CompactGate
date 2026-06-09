export function readChild(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function readSensitiveString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
