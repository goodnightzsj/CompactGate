import { MAX_API_KEY_PRIORITY } from "../../shared/api-key-priority.js";

export interface KeyPriorityEntry {
  id: string;
  priority: number | "";
}

export function orderedKeys<T extends KeyPriorityEntry>(entries: T[]): T[] {
  return [...entries].sort((left, right) => Number(right.priority) - Number(left.priority));
}

/** Only priorities change: IDs, secrets, labels and enabled flags stay owned by the form. */
export function moveKeyInOrder(
  entries: KeyPriorityEntry[],
  movedId: string,
  targetId: string,
  position: "before" | "after"
): KeyPriorityEntry[] | null {
  if (movedId === targetId || !entries.some((entry) => entry.id === movedId) ||
      !entries.some((entry) => entry.id === targetId)) return null;
  if (entries.length > MAX_API_KEY_PRIORITY + 1) throw new Error("Too many keys to assign distinct priorities.");
  const ids = orderedKeys(entries).map((entry) => entry.id);
  const next = ids.filter((id) => id !== movedId);
  next.splice(next.indexOf(targetId) + (position === "after" ? 1 : 0), 0, movedId);
  if (next.every((id, index) => id === ids[index])) return null;
  return next.map((id, index) => ({ id, priority: MAX_API_KEY_PRIORITY - index }));
}
