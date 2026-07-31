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
