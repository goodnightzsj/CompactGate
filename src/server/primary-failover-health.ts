import type {
  PrimaryCandidate,
  PrimaryProfileHealthSnapshot
} from "./primary-failover-types.js";
import {
  enforceMaxEntries,
  normalizeMaxEntries,
  rememberMapEntry
} from "./primary-failover-limits.js";

const DEFAULT_MAX_MODEL_COOLDOWN_ENTRIES = 512;

export interface ProfileHealth {
  version: number;
  inFlight: number;
  successes: number;
  failures: number;
  authFailures: number;
  quotaFailures: number;
  transientFailures: number;
  emptyStreamFailures: number;
  rateLimitFailures: number;
  modelIncompatibleFailuresByModel: Map<string, number>;
  cooldownUntil: number;
  quarantineUntil: number;
  rateLimitUntil: number;
  lastFirstTokenMs: number | null;
  lastSelectedAt: number;
  modelCooldowns: Map<string, ModelCooldown>;
}

export interface ModelCooldown {
  until: number;
  reason: string;
}

export class PrimaryProfileHealthStore {
  private readonly health = new Map<string, ProfileHealth>();

  private readonly maxModelCooldownEntries: number;

  constructor(maxModelCooldownEntries?: number) {
    this.maxModelCooldownEntries = normalizeMaxEntries(
      maxModelCooldownEntries,
      DEFAULT_MAX_MODEL_COOLDOWN_ENTRIES
    );
  }

  clear(): void {
    this.health.clear();
  }

  get(profileId: string): ProfileHealth | null {
    return this.health.get(profileId) ?? null;
  }

  forProfile(profileId: string): ProfileHealth {
    const existing = this.health.get(profileId);
    if (existing) {
      return existing;
    }

    const created: ProfileHealth = {
      version: 0,
      inFlight: 0,
      successes: 0,
      failures: 0,
      authFailures: 0,
      quotaFailures: 0,
      transientFailures: 0,
      emptyStreamFailures: 0,
      rateLimitFailures: 0,
      modelIncompatibleFailuresByModel: new Map(),
      cooldownUntil: 0,
      quarantineUntil: 0,
      rateLimitUntil: 0,
      lastFirstTokenMs: null,
      lastSelectedAt: 0,
      modelCooldowns: new Map()
    };
    this.health.set(profileId, created);
    return created;
  }

  reconcile(candidates: PrimaryCandidate[]): void {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    for (const id of [...this.health.keys()]) {
      if (!candidateIds.has(id)) {
        this.health.delete(id);
      }
    }
    for (const candidate of candidates) {
      this.forProfile(candidate.id);
    }
  }

  rememberModelCooldown(health: ProfileHealth, model: string, cooldown: ModelCooldown): void {
    rememberMapEntry(health.modelCooldowns, model, cooldown);
    enforceMaxEntries(health.modelCooldowns, this.maxModelCooldownEntries);
  }

  blockedUntil(profileId: string, model: string | null, now: number): number {
    const health = this.forProfile(profileId);
    const modelCooldown = model ? health.modelCooldowns.get(model)?.until ?? 0 : 0;
    if (model && modelCooldown > 0 && modelCooldown <= now) {
      health.modelCooldowns.delete(model);
    }

    return Math.max(
      health.cooldownUntil,
      health.quarantineUntil,
      health.rateLimitUntil,
      modelCooldown
    );
  }

  cleanupExpiredModelCooldowns(now: number): void {
    for (const health of this.health.values()) {
      for (const [model, cooldown] of health.modelCooldowns.entries()) {
        if (cooldown.until <= now) {
          health.modelCooldowns.delete(model);
        }
      }
    }
  }

  snapshot(): PrimaryProfileHealthSnapshot[] {
    return [...this.health.entries()].map(([profileId, health]) => ({
      profileId,
      inFlight: health.inFlight,
      transientFailures: health.transientFailures,
      emptyStreamFailures: health.emptyStreamFailures,
      cooldownUntil: health.cooldownUntil,
      quarantineUntil: health.quarantineUntil,
      rateLimitUntil: health.rateLimitUntil,
      modelCooldowns: [...health.modelCooldowns.entries()].map(([model, cooldown]) => ({
        model,
        until: cooldown.until,
        reason: cooldown.reason
      }))
    }));
  }
}
