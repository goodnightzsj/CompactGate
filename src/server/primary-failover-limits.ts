export function normalizeMaxEntries(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export function rememberMapEntry<Value>(map: Map<string, Value>, key: string, entry: Value): void {
  map.delete(key);
  map.set(key, entry);
}

export function enforceMaxEntries<Value>(map: Map<string, Value>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    map.delete(oldestKey);
  }
}
