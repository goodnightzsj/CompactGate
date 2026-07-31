import { createHash } from "node:crypto";
import type { CompactGateConfig, PrimaryUpstreamConfig } from "../shared/types.js";
import { codexPrimaryCandidates } from "./primary-failover-candidates.js";

export function stateDomainForPrimary(
  primary: PrimaryUpstreamConfig,
  profileId: string | null = null
): string {
  const explicit = primary.state_domain_id.trim();
  if (explicit) {
    return explicit;
  }
  const origin = new URL(primary.base_url).origin;
  return profileId ? `profile:${profileId}:${origin}` : origin;
}

export function stateDomainForProfile(
  config: CompactGateConfig,
  profileId: string | null
): string | null {
  if (!profileId) {
    return null;
  }
  const candidate = codexPrimaryCandidates(config).find((item) => item.id === profileId);
  return candidate ? stateDomainForPrimary(candidate.config.primary, profileId) : null;
}

export function hashStateDomain(stateDomain: string): string {
  return `sha256:${createHash("sha256").update(stateDomain).digest("hex")}`;
}
