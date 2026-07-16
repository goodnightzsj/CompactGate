import { createHash } from "node:crypto";
import type {
  CompactGateConfig,
  SavedConfigProfile,
  UpstreamConfig
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
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
    config: configWithProfilePrimary(config, profile)
  }));
}

export function candidateSignature(candidates: PrimaryCandidate[]): string {
  const candidateParts = candidates.map((candidate) => [
    candidate.id,
    candidate.config.primary.base_url,
    candidate.config.primary.api_key_env,
    candidate.config.primary.model_override ?? "",
    primaryCredentialSignature(candidate.config)
  ].join("|"));
  return candidateParts.join("::");
}

function primaryCredentialSignature(config: CompactGateConfig): string {
  const credential = resolveRouteCredential("primary", config);
  return [
    credential.apiKeySource,
    credential.activeApiKeyEnv ?? "",
    credential.apiKey ? credentialHash(credential.apiKey) : ""
  ].join(":");
}

function credentialHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function configWithProfilePrimary(config: CompactGateConfig, profile: SavedConfigProfile): CompactGateConfig {
  return {
    ...cloneConfig(config),
    primary: {
      ...config.primary,
      ...readProfilePrimary(profile)
    }
  };
}

function readProfilePrimary(profile: SavedConfigProfile): Partial<UpstreamConfig> | null {
  const config = profile.config;
  if (!isRecord(config) || !isRecord(config.primary)) {
    return null;
  }

  return config.primary as Partial<UpstreamConfig>;
}

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
