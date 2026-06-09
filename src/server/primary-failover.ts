import type { CompactGateConfig } from "../shared/types.js";
import {
  candidateSignature,
  codexPrimaryCandidates
} from "./primary-failover-candidates.js";
import { normalizeRequestContext } from "./primary-failover-context.js";
import {
  classifyPrimaryRouteResult,
  isReconnectLikePrimaryFailure,
  rateLimitCooldownMs,
  readResponseId
} from "./primary-failover-result.js";
import type {
  PrimaryCandidate,
  PrimaryProfileHealthSnapshot,
  PrimaryRouteRequestContext,
  PrimaryRouteResult,
  PrimaryRouteSelection
} from "./primary-failover-types.js";

export { primaryRouteRequestContextFromBody } from "./primary-failover-context.js";
export {
  classifyPrimaryRouteResult,
  isReconnectLikePrimaryFailure
} from "./primary-failover-result.js";
export type {
  PrimaryProfileHealthSnapshot,
  PrimaryResultCategory,
  PrimaryRouteRequestContext,
  PrimaryRouteResult,
  PrimaryRouteSelection
} from "./primary-failover-types.js";

const EMPTY_STREAM_FAILURE_THRESHOLD = 4;
const SESSION_STICKY_TTL_MS = 30 * 60 * 1000;
const CONTINUATION_STICKY_TTL_MS = 2 * 60 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const TRANSIENT_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const ACCOUNT_QUARANTINE_MS = 30 * 60 * 1000;
const MODEL_DISABLE_MS = 12 * 60 * 60 * 1000;
const TOP_K_SCORE_WINDOW = 100;
const DEFAULT_MAX_STICKY_ENTRIES = 2_048;
const DEFAULT_MAX_MODEL_COOLDOWN_ENTRIES = 512;

interface ProfileHealth {
  version: number;
  inFlight: number;
  successes: number;
  failures: number;
  transientFailures: number;
  emptyStreamFailures: number;
  rateLimitFailures: number;
  cooldownUntil: number;
  quarantineUntil: number;
  rateLimitUntil: number;
  lastFirstTokenMs: number | null;
  lastSelectedAt: number;
  modelCooldowns: Map<string, ModelCooldown>;
}

interface ModelCooldown {
  until: number;
  reason: string;
}

interface StickyEntry {
  profileId: string;
  expiresAt: number;
}

interface ScoredCandidate {
  candidate: PrimaryCandidate;
  score: number;
}

interface PrimaryFailoverOptions {
  now?: () => number;
  random?: () => number;
  maxStickyEntries?: number;
  maxModelCooldownEntries?: number;
}

export class PrimaryFailoverState {
  private signature = "";
  private generation = 0;
  private readonly health = new Map<string, ProfileHealth>();
  private readonly sessionStickiness = new Map<string, StickyEntry>();
  private readonly continuationStickiness = new Map<string, StickyEntry>();
  private readonly compactionStateStickiness = new Map<string, StickyEntry>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxStickyEntries: number;
  private readonly maxModelCooldownEntries: number;

  constructor(options: PrimaryFailoverOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.maxStickyEntries = normalizeMaxEntries(options.maxStickyEntries);
    this.maxModelCooldownEntries = normalizeMaxEntries(options.maxModelCooldownEntries, DEFAULT_MAX_MODEL_COOLDOWN_ENTRIES);
  }

  select(
    config: CompactGateConfig,
    context: PrimaryRouteRequestContext = {}
  ): PrimaryRouteSelection {
    return this.selectInternal(config, context, true);
  }

  preview(
    config: CompactGateConfig,
    context: PrimaryRouteRequestContext = {}
  ): PrimaryRouteSelection {
    return this.selectInternal(config, context, false);
  }

  recordResult(
    selection: PrimaryRouteSelection,
    resultOrStatus: PrimaryRouteResult | number,
    maybeErrorSummary?: string | null
  ): void {
    if (!selection.profileId) {
      return;
    }

    const result = normalizeResult(resultOrStatus, maybeErrorSummary);
    const health = this.health.get(selection.profileId);
    if (!health) {
      return;
    }

    health.inFlight = Math.max(0, health.inFlight - 1);
    if (selection.generation !== this.generation) {
      return;
    }

    const now = this.now();
    const category = classifyPrimaryRouteResult(result);
    const staleSuccess = category === "success" && selection.healthVersion !== health.version;
    const countsAsProfileFailure =
      category !== "success" && category !== "request_shape" && category !== "client_cancel";
    if (countsAsProfileFailure) {
      health.failures += 1;
    }

    switch (category) {
      case "success":
        health.successes += 1;
        health.lastFirstTokenMs = result.firstTokenMs ?? health.lastFirstTokenMs;
        if (!staleSuccess) {
          health.transientFailures = 0;
          health.emptyStreamFailures = 0;
          health.rateLimitFailures = 0;
          health.cooldownUntil = 0;
          health.rateLimitUntil = 0;
          health.version += 1;
        }
        this.rememberResponseStickiness(selection, result, now);
        break;
      case "auth":
      case "quota":
        health.transientFailures = 0;
        health.emptyStreamFailures = 0;
        health.quarantineUntil = Math.max(health.quarantineUntil, now + ACCOUNT_QUARANTINE_MS);
        health.version += 1;
        break;
      case "rate_limit": {
        health.rateLimitFailures += 1;
        health.rateLimitUntil = Math.max(
          health.rateLimitUntil,
          now + rateLimitCooldownMs(result, health.rateLimitFailures, now)
        );
        health.version += 1;
        break;
      }
      case "transient": {
        health.transientFailures += 1;
        if (isReconnectLikePrimaryFailure(result.status, result.errorSummary)) {
          health.emptyStreamFailures += 1;
        }
        const shouldCooldown =
          !isReconnectLikePrimaryFailure(result.status, result.errorSummary) ||
          health.emptyStreamFailures >= EMPTY_STREAM_FAILURE_THRESHOLD;
        if (shouldCooldown) {
          const multiplier = Math.max(1, health.transientFailures - EMPTY_STREAM_FAILURE_THRESHOLD + 1);
          health.cooldownUntil = Math.max(
            health.cooldownUntil,
            now + Math.min(TRANSIENT_COOLDOWN_MAX_MS, TRANSIENT_COOLDOWN_MS * multiplier)
          );
        }
        health.version += 1;
        break;
      }
      case "model_incompatible": {
        const model = selection.context.model;
        if (model) {
          rememberMapEntry(health.modelCooldowns, model, {
            until: now + MODEL_DISABLE_MS,
            reason: result.errorSummary ?? `HTTP ${result.status}`
          });
          enforceMaxEntries(health.modelCooldowns, this.maxModelCooldownEntries);
        } else {
          health.cooldownUntil = Math.max(health.cooldownUntil, now + TRANSIENT_COOLDOWN_MS);
        }
        health.version += 1;
        break;
      }
      case "request_shape":
      case "client_cancel":
        break;
    }
  }

  getHealthSnapshot(): PrimaryProfileHealthSnapshot[] {
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

  private selectInternal(
    config: CompactGateConfig,
    context: PrimaryRouteRequestContext,
    reserve: boolean
  ): PrimaryRouteSelection {
    const candidates = codexPrimaryCandidates(config);
    const normalizedContext = normalizeRequestContext(context);
    if (candidates.length === 0) {
      return {
        config,
        profileId: null,
        profileName: null,
        generation: this.generation,
        healthVersion: 0,
        context: normalizedContext
      };
    }

    const signature = candidateSignature(config, candidates);
    if (signature !== this.signature) {
      this.signature = signature;
      this.generation += 1;
      this.health.clear();
      this.sessionStickiness.clear();
      this.continuationStickiness.clear();
      this.compactionStateStickiness.clear();
    }

    this.reconcileHealth(candidates);
    const now = this.now();
    this.cleanupExpiredState(now);

    const selected =
      this.selectStickyCandidate(candidates, normalizedContext, now) ??
      this.selectScoredCandidate(candidates, normalizedContext, now);
    const health = this.healthFor(selected.id);
    if (reserve) {
      health.inFlight += 1;
      health.lastSelectedAt = now;
      this.rememberRequestStickiness(normalizedContext, selected.id, now);
    }

    return {
      config: selected.config,
      profileId: selected.id,
      profileName: selected.name,
      generation: this.generation,
      healthVersion: health.version,
      context: normalizedContext
    };
  }

  private reconcileHealth(candidates: PrimaryCandidate[]): void {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    for (const id of [...this.health.keys()]) {
      if (!candidateIds.has(id)) {
        this.health.delete(id);
      }
    }
    for (const candidate of candidates) {
      this.healthFor(candidate.id);
    }
  }

  private selectStickyCandidate(
    candidates: PrimaryCandidate[],
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): PrimaryCandidate | null {
    if (context.previousResponseId) {
      const sticky = this.continuationStickiness.get(context.previousResponseId);
      const candidate = sticky
        ? this.usableCandidateById(candidates, sticky.profileId, context, now)
        : null;
      if (candidate) {
        return candidate;
      }
    }

    if (context.compactionStateKey) {
      const sticky = this.compactionStateStickiness.get(context.compactionStateKey);
      const candidate = sticky
        ? this.usableCandidateById(candidates, sticky.profileId, context, now)
        : null;
      if (candidate) {
        return candidate;
      }
    }

    if (context.sessionKey) {
      const sticky = this.sessionStickiness.get(context.sessionKey);
      const candidate = sticky
        ? this.usableCandidateById(candidates, sticky.profileId, context, now)
        : null;
      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  private selectScoredCandidate(
    candidates: PrimaryCandidate[],
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): PrimaryCandidate {
    const eligible = candidates.filter((candidate) => this.isCandidateEligible(candidate, context, now));
    const pool = eligible.length > 0
      ? eligible
      : [...candidates].sort((left, right) => {
          const leftUntil = this.blockedUntil(left, context, now);
          const rightUntil = this.blockedUntil(right, context, now);
          return leftUntil === rightUntil ? left.order - right.order : leftUntil - rightUntil;
        });
    const scored = pool
      .map((candidate) => ({
        candidate,
        score: this.scoreCandidate(candidate, context, now)
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.candidate.order - right.candidate.order;
      });
    const best = scored[0];
    if (!best) {
      return candidates[0];
    }

    const topK = scored
      .filter((candidate) => best.score - candidate.score <= TOP_K_SCORE_WINDOW)
      .slice(0, 3);
    if (topK.length <= 1) {
      return best.candidate;
    }

    return this.weightedChoice(topK);
  }

  private scoreCandidate(
    candidate: PrimaryCandidate,
    _context: Required<PrimaryRouteRequestContext>,
    _now: number
  ): number {
    const health = this.healthFor(candidate.id);
    const total = health.successes + health.failures;
    const errorRate = total > 0 ? health.failures / total : 0;
    const latencyPenalty = health.lastFirstTokenMs === null
      ? 0
      : Math.min(200, Math.round(health.lastFirstTokenMs / 100));

    return (
      10_000 -
      candidate.order * 500 -
      health.inFlight * 80 -
      health.transientFailures * 40 -
      Math.round(errorRate * 250) -
      latencyPenalty +
      (candidate.active ? 1_000 : 0)
    );
  }

  private weightedChoice(candidates: ScoredCandidate[]): PrimaryCandidate {
    const minScore = Math.min(...candidates.map((candidate) => candidate.score));
    const weights = candidates.map((candidate) => Math.max(1, candidate.score - minScore + 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = this.random() * total;
    for (let index = 0; index < candidates.length; index += 1) {
      roll -= weights[index];
      if (roll <= 0) {
        return candidates[index].candidate;
      }
    }

    return candidates[0].candidate;
  }

  private usableCandidateById(
    candidates: PrimaryCandidate[],
    profileId: string,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): PrimaryCandidate | null {
    const candidate = candidates.find((item) => item.id === profileId);
    if (!candidate || !this.isCandidateEligible(candidate, context, now)) {
      return null;
    }

    return candidate;
  }

  private isCandidateEligible(
    candidate: PrimaryCandidate,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): boolean {
    return this.blockedUntil(candidate, context, now) <= now;
  }

  private blockedUntil(
    candidate: PrimaryCandidate,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): number {
    const health = this.healthFor(candidate.id);
    const model = context.model;
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

  private rememberRequestStickiness(
    context: Required<PrimaryRouteRequestContext>,
    profileId: string,
    now: number
  ): void {
    if (context.sessionKey) {
      rememberStickyEntry(this.sessionStickiness, context.sessionKey, {
        profileId,
        expiresAt: now + SESSION_STICKY_TTL_MS
      });
      enforceMaxEntries(this.sessionStickiness, this.maxStickyEntries);
    }
    if (context.previousResponseId) {
      rememberStickyEntry(this.continuationStickiness, context.previousResponseId, {
        profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
      enforceMaxEntries(this.continuationStickiness, this.maxStickyEntries);
    }
  }

  private rememberResponseStickiness(
    selection: PrimaryRouteSelection,
    result: PrimaryRouteResult,
    now: number
  ): void {
    if (!selection.profileId) {
      return;
    }

    const responseId = readResponseId(result);
    if (responseId) {
      rememberStickyEntry(this.continuationStickiness, responseId, {
        profileId: selection.profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
      enforceMaxEntries(this.continuationStickiness, this.maxStickyEntries);
    }
    if (selection.context.sessionKey) {
      rememberStickyEntry(this.sessionStickiness, selection.context.sessionKey, {
        profileId: selection.profileId,
        expiresAt: now + SESSION_STICKY_TTL_MS
      });
      enforceMaxEntries(this.sessionStickiness, this.maxStickyEntries);
    }
    if (selection.context.compactionStateKey) {
      rememberStickyEntry(this.compactionStateStickiness, selection.context.compactionStateKey, {
        profileId: selection.profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
      enforceMaxEntries(this.compactionStateStickiness, this.maxStickyEntries);
    }
  }

  private cleanupExpiredState(now: number): void {
    cleanupStickyMap(this.sessionStickiness, now);
    cleanupStickyMap(this.continuationStickiness, now);
    cleanupStickyMap(this.compactionStateStickiness, now);
    for (const health of this.health.values()) {
      for (const [model, cooldown] of health.modelCooldowns.entries()) {
        if (cooldown.until <= now) {
          health.modelCooldowns.delete(model);
        }
      }
    }
  }

  private healthFor(profileId: string): ProfileHealth {
    const existing = this.health.get(profileId);
    if (existing) {
      return existing;
    }

    const created: ProfileHealth = {
      version: 0,
      inFlight: 0,
      successes: 0,
      failures: 0,
      transientFailures: 0,
      emptyStreamFailures: 0,
      rateLimitFailures: 0,
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
}

function normalizeResult(
  resultOrStatus: PrimaryRouteResult | number,
  maybeErrorSummary?: string | null
): PrimaryRouteResult {
  if (typeof resultOrStatus === "number") {
    return {
      status: resultOrStatus,
      errorSummary: maybeErrorSummary ?? null
    };
  }

  return resultOrStatus;
}

function cleanupStickyMap(map: Map<string, StickyEntry>, now: number): void {
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt <= now) {
      map.delete(key);
    }
  }
}

function rememberMapEntry<Value>(map: Map<string, Value>, key: string, entry: Value): void {
  map.delete(key);
  map.set(key, entry);
}

function rememberStickyEntry(map: Map<string, StickyEntry>, key: string, entry: StickyEntry): void {
  rememberMapEntry(map, key, entry);
}

function enforceMaxEntries<Value>(map: Map<string, Value>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    map.delete(oldestKey);
  }
}

function normalizeMaxEntries(value: number | undefined, fallback = DEFAULT_MAX_STICKY_ENTRIES): number {
  if (value === undefined) {
    return fallback;
  }

  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}
