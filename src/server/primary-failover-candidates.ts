import { createHash } from "node:crypto";
import type {
  CompactGateConfig,
  SavedConfigProfile,
  UpstreamConfig
} from "../shared/types.js";
import { cloneConfig } from "./config-clone.js";
import { resolveRouteCredential } from "./credentials.js";
import { isRecord } from "./http-utils.js";
import type { PrimaryCandidate } from "./primary-failover-types.js";

export function codexPrimaryCandidates(config: CompactGateConfig): PrimaryCandidate[] {
  const state = config.profile_scopes?.codex;
  const profiles = state?.profiles ?? [];
  if (profiles.length === 0 || !state?.active_profile_id) {
    return [];
  }

  const candidates = profiles.filter((profile) => Boolean(readProfilePrimary(profile)));
  const activeIndex = candidates.findIndex((profile) => profile.id === state.active_profile_id);

  return candidates.map((profile, index) => ({
    id: profile.id,
    name: profile.name,
    order: activeIndex >= 0
      ? (index - activeIndex + candidates.length) % candidates.length
      : index,
    active: profile.id === state.active_profile_id,
    config: {
      ...cloneConfig(config),
      primary: {
        ...config.primary,
        ...readProfilePrimary(profile)
      }
    }
  }));
}

export function candidateSignature(candidates: PrimaryCandidate[]): string {
  const candidateParts = candidates.map((candidate) => [
    candidate.id,
    candidate.config.primary.base_url,
    candidate.config.primary.api_key_env,
    candidate.config.primary.model_override ?? "",
    candidate.config.primary.reasoning_effort,
    candidate.config.primary.state_domain_id,
    primaryCredentialSignature(candidate.config)
  ].join("|"));
  return candidateParts.join("::");
}

function primaryCredentialSignature(config: CompactGateConfig): string {
  const credential = resolveRouteCredential("primary", config);
  return [
    credential.apiKeySource,
    credential.activeApiKeyEnv ?? "",
    credential.apiKey ? createHash("sha256").update(credential.apiKey).digest("hex") : ""
  ].join(":");
}

function readProfilePrimary(profile: SavedConfigProfile): Partial<UpstreamConfig> | null {
  const config = profile.config;
  if (!isRecord(config) || !isRecord(config.primary)) {
    return null;
  }

  return config.primary as Partial<UpstreamConfig>;
}
