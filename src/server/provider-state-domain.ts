import { createHash } from "node:crypto";
import type { CompactGateConfig, PrimaryUpstreamConfig } from "../shared/types.js";
import { codexPrimaryCandidates } from "./primary-failover-candidates.js";

/**
 * The default domain must isolate by key, not just by profile: each key in a
 * pool is a distinct upstream account, and provider state (Codex encrypted
 * turn state, prompt caches) is account-bound. An explicit `state_domain_id`
 * still overrides, for the case where several keys really do share one account.
 */
export function stateDomainForPrimary(
  primary: PrimaryUpstreamConfig,
  profileId: string | null = null,
  keyId: string | null = null
): string {
  const explicit = primary.state_domain_id.trim();
  if (explicit) {
    return explicit;
  }
  const origin = new URL(primary.base_url).origin;
  if (profileId && keyId) {
    return `profile:${profileId}#${keyId}:${origin}`;
  }
  return profileId ? `profile:${profileId}:${origin}` : origin;
}

export function stateDomainForProfile(
  config: CompactGateConfig,
  profileId: string | null
): string | null {
  if (!profileId) {
    return null;
  }
  // Matching by profileId rather than composite candidate id: the persisted
  // provider-state binding table and the `x-compactgate-profile` header are
  // profile-scoped, and a pooled profile's first key is its representative.
  const candidate = codexPrimaryCandidates(config)
    .filter((item) => item.profileId === profileId)
    .sort((left, right) => left.order - right.order)[0];
  return candidate
    ? stateDomainForPrimary(candidate.config.primary, profileId, candidate.keyId)
    : null;
}

export function hashStateDomain(stateDomain: string): string {
  return `sha256:${createHash("sha256").update(stateDomain).digest("hex")}`;
}
