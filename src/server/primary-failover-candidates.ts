import { createHash } from "node:crypto";
import type {
  CompactGateConfig,
  SavedConfigProfile,
  UpstreamApiKey,
  UpstreamConfig
} from "../shared/types.js";
import { cloneConfig } from "./config-internals.js";
import { enabledApiKeyPool, resolveRouteCredential } from "./credentials.js";
import { isRecord } from "./http-utils.js";
import type { PrimaryCandidate } from "./primary-failover-types.js";

/**
 * Expand each codex profile into one candidate per schedulable key. Health,
 * cooldowns and stickiness are keyed by the composite `profileId#keyId`, so a
 * single profile's keys quarantine and recover independently — the same
 * per-candidate isolation profiles already have. A profile without a pool keeps
 * its plain profile id, which is also what keeps existing configs' state
 * domains and stickiness keys stable across the upgrade.
 */
export function codexPrimaryCandidates(config: CompactGateConfig): PrimaryCandidate[] {
  const state = config.profile_scopes?.codex;
  const profiles = state?.profiles ?? [];
  if (profiles.length === 0 || !state?.active_profile_id) {
    return [];
  }

  const eligible = profiles.filter((profile) => Boolean(readProfilePrimary(profile)));
  const activeIndex = eligible.findIndex((profile) => profile.id === state.active_profile_id);
  // The profile's position in the failover sequence, rotated so the active
  // profile is order 0. Keys inherit it: `fill_first` offsets each key from it,
  // `spread` shares it so the top-K weighted pick distributes across the keys.
  const profileOrder = (index: number) =>
    activeIndex >= 0 ? (index - activeIndex + eligible.length) % eligible.length : index;

  const runtimeStrategy = config.primary.key_strategy ?? "fill_first";
  const candidates: PrimaryCandidate[] = [];

  // fill_first needs globally unique orders — keys must be strictly adjacent to
  // their profile — so walk the rotated sequence and number the flattened list.
  // A per-profile `profileOrder + keyIndex` would collide A's second key with
  // B's first and blend two profiles into one top-K window.
  const rotation = eligible
    .map((profile, index) => ({ profile, index }))
    .sort((left, right) => profileOrder(left.index) - profileOrder(right.index));
  let sequentialOrder = 0;

  for (const { profile, index } of rotation) {
    const profilePrimary = readProfilePrimary(profile) as Partial<UpstreamConfig>;
    const mergedPrimary = { ...config.primary, ...profilePrimary };
    // Strategy is a per-profile choice with the runtime primary as its default.
    const spread = (
      (profilePrimary as Partial<{ key_strategy: string }>).key_strategy ??
      runtimeStrategy
    ) === "spread";
    const pool = enabledApiKeyPool(mergedPrimary);
    const sharedOrder = profileOrder(index);

    // Every key of the active profile carries the active bonus. Marking only
    // the first key gave it +1000, which pushed its spread siblings out of the
    // top-K window and silently reverted the pool to fill_first.
    const profileIsActive = profile.id === state.active_profile_id;
    const rotationOptOut = (profilePrimary as Partial<{ rotation_opt_out: boolean }>)
      .rotation_opt_out === true;

    if (pool.length <= 1) {
      // Single key (or none): the profile itself is the candidate, exactly as
      // before pools existed. A one-entry pool keeps its composite id so that
      // adding a second key later starts the new key's health from zero without
      // touching the first key's history.
      const single = pool[0];
      candidates.push({
        id: single ? `${profile.id}#${single.id}` : profile.id,
        profileId: profile.id,
        keyId: single?.id ?? null,
        keyLabel: single?.label ?? null,
        name: single?.label ? `${profile.name} · ${single.label}` : profile.name,
        order: spread ? sharedOrder : sequentialOrder++,
        active: profileIsActive,
        rotationOptOut,
        config: withPrimaryConfig(config, profilePrimary, single)
      });
      continue;
    }

    pool.forEach((key, keyIndex) => {
      candidates.push({
        id: `${profile.id}#${key.id}`,
        profileId: profile.id,
        keyId: key.id,
        keyLabel: key.label || null,
        name: key.label ? `${profile.name} · ${key.label}` : `${profile.name} · #${keyIndex + 1}`,
        // fill_first burns one key before the next; spread shares the profile's
        // slot so sibling keys land in the same top-K score window.
        order: spread ? sharedOrder : sequentialOrder++,
        active: profileIsActive,
        rotationOptOut,
        config: withPrimaryConfig(config, profilePrimary, key)
      });
    });
  }

  return candidates;
}

export function candidateSignature(candidates: PrimaryCandidate[]): string {
  return candidates.map((candidate) => profileSignature(candidate)).join("::");
}

/**
 * One signature per candidate rather than one for the whole set. Health and
 * stickiness are per candidate, so a change to one key must only invalidate
 * that key — collapsing them into a single string made rotating one credential
 * wipe every session's account pin and un-quarantine unrelated broken accounts.
 */
export function candidateSignatures(candidates: PrimaryCandidate[]): Map<string, string> {
  return new Map(candidates.map((candidate) => [candidate.id, profileSignature(candidate)]));
}

function withPrimaryConfig(
  config: CompactGateConfig,
  profilePrimary: Partial<UpstreamConfig>,
  key: UpstreamApiKey | undefined
): CompactGateConfig {
  return {
    ...cloneConfig(config),
    primary: {
      ...config.primary,
      ...profilePrimary,
      ...(key ? { api_key: key.api_key } : {})
    }
  };
}

function profileSignature(candidate: PrimaryCandidate): string {
  return [
    candidate.id,
    candidate.config.primary.base_url,
    candidate.config.primary.api_key_env,
    candidate.config.primary.upstream_protocol,
    candidate.config.primary.model_override ?? "",
    candidate.config.primary.reasoning_effort,
    candidate.config.primary.state_domain_id,
    primaryTransportSignature(candidate.config.primary),
    primaryCredentialSignature(candidate.config)
  ].join("|");
}

function primaryTransportSignature(primary: CompactGateConfig["primary"]): string {
  return createHash("sha256").update(JSON.stringify({
    extra_headers: Object.entries(primary.extra_headers).sort(([left], [right]) => left.localeCompare(right)),
    proxy_url: primary.proxy_url
  })).digest("hex");
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
