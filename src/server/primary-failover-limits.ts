export function normalizeMaxEntries(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

export function rememberMapEntry<Value>(map: Map<string, Value>, key: string, entry: Value): void {
  map.delete(key);
  map.set(key, entry);
}

export function enforceMaxEntries<Value>(map: Map<string, Value>, maxEntries: number): void {
  while (map.size > Math.max(0, maxEntries)) {
    map.delete(map.keys().next().value as string);
  }
}
