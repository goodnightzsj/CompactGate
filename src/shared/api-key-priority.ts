export const MAX_API_KEY_PRIORITY = 100;
/** Reserved identity of the route's direct api_key, never a stored pool entry. */
export const DIRECT_API_KEY_ID = "__direct__";

export function isApiKeyPriority(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= MAX_API_KEY_PRIORITY;
}
