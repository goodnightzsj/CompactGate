import { createHash } from "node:crypto";
import type { PrimaryRouteRequestContext } from "./primary-failover.js";

export interface ProviderStateBinding {
  stateDomainId: string;
  profileId: string;
  generation: number;
  expiresAt: number;
}

export function providerStateBindingIdentityHashes(
  context: PrimaryRouteRequestContext,
  responseId?: string | null
): string[] {
  const identities: Array<[string, string | null | undefined]> = [
    ["continuation", context.previousResponseId],
    ["compaction", context.compactionStateKey],
    ["session", context.sessionKey],
    ["continuation", responseId]
  ];
  const hashes = identities.flatMap(([kind, value]) => {
    const normalized = value?.trim();
    return normalized ? [hashProviderStateIdentity(kind, normalized)] : [];
  });
  return [...new Set(hashes)];
}

export function hashProviderStateIdentity(kind: string, value: string): string {
  return `sha256:${createHash("sha256")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex")}`;
}

/**
 * The stable identity for "this conversation", used by the two-strike recovery
 * evidence counter and by the logged `conversation hash`.
 *
 * Deliberately not `providerStateBindingIdentityHashes()[0]`: that array is ordered
 * by *specificity* for binding lookup and therefore leads with
 * `previous_response_id`, which is the least stable identity available — it changes
 * every turn. Keying the 10-minute counter on it meant the second strike could only
 * ever come from retrying the same turn, so the threshold was unreachable in a
 * normal conversation, and every turn of one conversation logged a different
 * conversation hash. Preferring the session key also stops the identity from
 * silently switching the first time a `compaction` item appears mid-conversation,
 * which reset the counter.
 */
export function providerStateConversationHash(
  context: PrimaryRouteRequestContext
): string | null {
  const identities: Array<[string, string | null | undefined]> = [
    ["session", context.sessionKey],
    ["compaction", context.compactionStateKey],
    ["continuation", context.previousResponseId]
  ];
  for (const [kind, value] of identities) {
    const normalized = value?.trim();
    if (normalized) {
      return hashProviderStateIdentity(kind, normalized);
    }
  }
  return null;
}
