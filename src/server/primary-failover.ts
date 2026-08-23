import type { CompactGateConfig } from "../shared/types.js";
import {
  candidateSignatures,
  codexPrimaryCandidates
} from "./primary-failover-candidates.js";
import { normalizeRequestContext } from "./primary-failover-context.js";
import {
  classifyPrimaryRouteResult,
  isReconnectLikePrimaryFailure,
  rateLimitCooldownMs
} from "./primary-failover-result.js";
import {
  PrimaryProfileHealthStore
} from "./primary-failover-health.js";
import { PrimaryStickinessStore } from "./primary-failover-stickiness.js";
import type {
  PrimaryCandidate,
  PrimaryRouteRequestContext,
  PrimaryRouteResult,
  PrimaryRouteSelection
} from "./primary-failover-types.js";

export { primaryRouteRequestContextFromBody } from "./primary-failover-context.js";
export { classifyPrimaryRouteResult } from "./primary-failover-result.js";
export type {
  PrimaryRouteRequestContext,
  PrimaryRouteResult,
  PrimaryRouteSelection
} from "./primary-failover-types.js";

const FAILOVER_FAILURE_THRESHOLD = 11;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const TRANSIENT_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const ACCOUNT_QUARANTINE_MS = 30 * 60 * 1000;
const MODEL_DISABLE_MS = 12 * 60 * 60 * 1000;
const TOP_K_SCORE_WINDOW = 100;

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
  private signatures = new Map<string, string>();
  private generation = 0;
  private forcedProfileId: string | null = null;
  private readonly health: PrimaryProfileHealthStore;
  private readonly stickiness: PrimaryStickinessStore;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: PrimaryFailoverOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.health = new PrimaryProfileHealthStore(options.maxModelCooldownEntries);
    this.stickiness = new PrimaryStickinessStore(options.maxStickyEntries);
  }

  reserveSelection(
    selection: PrimaryRouteSelection,
    rememberRequestStickiness: boolean
  ): void {
    if (!selection.profileId) {
      return;
    }

    const health = this.health.get(selection.profileId);
    if (!health || selection.generation !== this.generation) {
      throw new Error("Cannot reserve a stale primary route selection.");
    }

    const now = this.now();
    if (selection.profileId === this.forcedProfileId) {
      this.forcedProfileId = null;
    }
    health.inFlight += 1;
    health.lastSelectedAt = now;
    if (rememberRequestStickiness) {
      this.stickiness.rememberRequest(selection.context, selection.profileId, now);
    }
  }

  recordResult(
    selection: PrimaryRouteSelection,
    resultOrStatus: PrimaryRouteResult | number,
    maybeErrorSummary?: string | null
  ): void {
    if (!selection.profileId) {
      return;
    }

    const result = typeof resultOrStatus === "number"
      ? {
          status: resultOrStatus,
          errorSummary: maybeErrorSummary ?? null
        }
      : resultOrStatus;
    const health = this.health.get(selection.profileId);
    if (!health) {
      return;
    }

    // Release the reservation before the staleness check. The generation moves
    // whenever *any* candidate's config changes, while an unchanged profile
    // keeps its health record — so returning first leaked one inFlight for
    // every request that was open across an unrelated config edit, and each
    // leaked unit is a permanent -80 on that profile's score.
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
          health.authFailures = 0;
          health.quotaFailures = 0;
          health.transientFailures = 0;
          health.emptyStreamFailures = 0;
          health.rateLimitFailures = 0;
          health.modelIncompatibleFailuresByModel.clear();
          health.cooldownUntil = 0;
          health.rateLimitUntil = 0;
          // A success is direct proof the profile works again, which is exactly
          // the evidence the long blocks should yield to. Without this, topping
          // up a quota or an upstream fixing its model catalog leaves the
          // profile shut out for the rest of the 30 minute / 12 hour window,
          // because only a credential change resets health otherwise.
          health.quarantineUntil = 0;
          if (selection.context.model) {
            health.modelCooldowns.delete(selection.context.model);
          }
          health.version += 1;
        }
        this.stickiness.rememberResponse(selection, result, now);
        break;
      case "auth":
      case "quota": {
        if (category === "auth") {
          health.authFailures += 1;
        } else {
          health.quotaFailures += 1;
        }
        health.transientFailures = 0;
        health.emptyStreamFailures = 0;
        if (
          health.authFailures >= FAILOVER_FAILURE_THRESHOLD ||
          health.quotaFailures >= FAILOVER_FAILURE_THRESHOLD
        ) {
          health.quarantineUntil = Math.max(health.quarantineUntil, now + ACCOUNT_QUARANTINE_MS);
        }
        health.version += 1;
        break;
      }
      case "rate_limit": {
        health.rateLimitFailures += 1;
        if (health.rateLimitFailures >= FAILOVER_FAILURE_THRESHOLD) {
          const cooldownFailureCount = Math.max(
            1,
            health.rateLimitFailures - FAILOVER_FAILURE_THRESHOLD + 1
          );
          health.rateLimitUntil = Math.max(
            health.rateLimitUntil,
            now + rateLimitCooldownMs(result, cooldownFailureCount, now)
          );
        }
        health.version += 1;
        break;
      }
      case "transient": {
        health.transientFailures += 1;
        if (isReconnectLikePrimaryFailure(result.status, result.errorSummary)) {
          health.emptyStreamFailures += 1;
        }
        const shouldCooldown =
          health.transientFailures >= FAILOVER_FAILURE_THRESHOLD &&
          (
            !isReconnectLikePrimaryFailure(result.status, result.errorSummary) ||
            health.emptyStreamFailures >= FAILOVER_FAILURE_THRESHOLD
          );
        if (shouldCooldown) {
          const multiplier = Math.max(1, health.transientFailures - FAILOVER_FAILURE_THRESHOLD + 1);
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
        const modelFailureKey = model ?? "";
        const modelFailures = (health.modelIncompatibleFailuresByModel.get(modelFailureKey) ?? 0) + 1;
        health.modelIncompatibleFailuresByModel.set(modelFailureKey, modelFailures);
        // Bounded like every other per-model map in this state. Keyed by the
        // client-supplied model string, this was the one map with neither a size
        // cap nor an expiry: entries leave only by reaching the threshold or by a
        // non-stale success clearing the whole map, so a client sending varying
        // model names against an upstream that answers "model not found" grew it
        // for the process's lifetime.
        this.health.enforceModelFailureBound(health);
        if (modelFailures >= FAILOVER_FAILURE_THRESHOLD) {
          if (model) {
            this.health.rememberModelCooldown(health, model, {
              until: now + MODEL_DISABLE_MS,
              reason: result.errorSummary ?? `HTTP ${result.status}`
            });
          } else {
            health.cooldownUntil = Math.max(health.cooldownUntil, now + TRANSIENT_COOLDOWN_MS);
          }
          health.modelIncompatibleFailuresByModel.delete(modelFailureKey);
        }
        health.version += 1;
        break;
      }
      case "request_shape":
      case "client_cancel":
        break;
    }
  }

  boundProfileId(context: PrimaryRouteRequestContext): string | null {
    const now = this.now();
    this.cleanupExpiredState(now);
    return this.stickiness.findProfileId(normalizeRequestContext(context));
  }

  /**
   * Applying a codex profile means "move everyone onto it", so dropping the
   * existing pins is intended. Only do it for a profile that can actually be
   * selected — a profile with no `primary` block is never a candidate, and
   * clearing every session's pin for one that can never win costs them all a
   * prompt cache for nothing.
   */
  forceNextProfileSelection(config: CompactGateConfig, profileId: string): void {
    const isCandidate = codexPrimaryCandidates(config)
      .some((candidate) => candidate.id === profileId);
    if (!isCandidate) {
      return;
    }

    this.stickiness.clear();
    this.forcedProfileId = profileId;
  }

  preview(
    config: CompactGateConfig,
    context: PrimaryRouteRequestContext = {}
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

    const signatures = candidateSignatures(candidates);
    const changedProfileIds = new Set<string>();
    const removedProfileIds = new Set<string>();
    for (const [profileId, signature] of signatures) {
      const previous = this.signatures.get(profileId);
      if (previous !== undefined && previous !== signature) {
        changedProfileIds.add(profileId);
      }
    }
    for (const profileId of this.signatures.keys()) {
      if (!signatures.has(profileId)) {
        removedProfileIds.add(profileId);
      }
    }
    this.signatures = signatures;
    if (changedProfileIds.size > 0) {
      // The generation still moves for everyone: an in-flight selection was
      // computed against the old candidate set, so its result can no longer be
      // attributed safely. Only the profiles that actually changed lose their
      // health record and their pins.
      this.generation += 1;
      this.health.forgetProfiles(changedProfileIds);
      this.stickiness.forgetProfiles(changedProfileIds);
    }
    if (removedProfileIds.size > 0) {
      // `reconcile` drops a deleted profile's health, but its pins would
      // otherwise sit in the sticky maps until their 30 minute / 2 hour TTL,
      // occupying LRU slots and evicting live pins. No generation bump: with
      // the health record gone, `recordResult` already no-ops for them.
      this.stickiness.forgetProfiles(removedProfileIds);
    }

    this.health.reconcile(candidates);

    const forcedCandidate = this.forcedProfileId
      ? candidates.find((candidate) => candidate.id === this.forcedProfileId) ?? null
      : null;
    if (this.forcedProfileId && !forcedCandidate) {
      this.forcedProfileId = null;
    }
    if (forcedCandidate) {
      const health = this.health.forProfile(forcedCandidate.id);
      return {
        config: forcedCandidate.config,
        profileId: forcedCandidate.id,
        profileName: forcedCandidate.name,
        generation: this.generation,
        healthVersion: health.version,
        context: normalizedContext
      };
    }

    if (!config.primary_failover.auto_schedule) {
      const selected = candidates.find((candidate) => candidate.active) ?? candidates[0];
      const health = this.health.forProfile(selected.id);
      return {
        config: selected.config,
        profileId: selected.id,
        profileName: selected.name,
        generation: this.generation,
        healthVersion: health.version,
        context: normalizedContext
      };
    }

    const now = this.now();
    this.cleanupExpiredState(now);

    const selected = this.selectCandidate(candidates, normalizedContext, now);
    const health = this.health.forProfile(selected.id);
    return {
      config: selected.config,
      profileId: selected.id,
      profileName: selected.name,
      generation: this.generation,
      healthVersion: health.version,
      context: normalizedContext
    };
  }

  private selectCandidate(
    candidates: PrimaryCandidate[],
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): PrimaryCandidate {
    const stickyProfileId = this.stickiness.selectProfileId(
      context,
      (profileId) => this.usableCandidate(candidates, context, now, profileId) !== null
    );
    const sticky = stickyProfileId
      ? this.usableCandidate(candidates, context, now, stickyProfileId)
      : null;
    if (sticky) {
      return sticky;
    }

    const eligible = candidates.filter((candidate) => this.isEligible(candidate, context, now));
    if (eligible.length === 0) {
      // Nothing is usable, so the request has to land somewhere regardless.
      // Health scoring is the wrong tie-break here — it would happily pick a
      // profile quarantined for half an hour over one that recovers in a
      // second. Take the soonest to unblock instead.
      return [...candidates].sort((left, right) => {
        const leftUntil = this.health.blockedUntil(left.id, context.model, now);
        const rightUntil = this.health.blockedUntil(right.id, context.model, now);
        return leftUntil === rightUntil ? left.order - right.order : leftUntil - rightUntil;
      })[0] ?? candidates[0];
    }

    const scored = eligible
      .map((candidate) => ({
        candidate,
        score: this.scoreCandidate(candidate)
      }))
      .sort((left, right) => right.score !== left.score
        ? right.score - left.score
        : left.candidate.order - right.candidate.order);
    const best = scored[0];
    if (!best) {
      return candidates[0];
    }

    const topK = scored
      .filter((candidate) => best.score - candidate.score <= TOP_K_SCORE_WINDOW)
      .slice(0, 3);
    return topK.length <= 1 ? best.candidate : weightedChoice(topK, this.random);
  }

  private scoreCandidate(candidate: PrimaryCandidate): number {
    const health = this.health.forProfile(candidate.id);
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

  private usableCandidate(
    candidates: PrimaryCandidate[],
    context: Required<PrimaryRouteRequestContext>,
    now: number,
    profileId: string
  ): PrimaryCandidate | null {
    const candidate = candidates.find((item) => item.id === profileId);
    return candidate && this.isEligible(candidate, context, now) ? candidate : null;
  }

  private isEligible(
    candidate: PrimaryCandidate,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): boolean {
    return this.health.blockedUntil(candidate.id, context.model, now) <= now;
  }

  private cleanupExpiredState(now: number): void {
    this.stickiness.cleanup(now);
    this.health.cleanupExpiredModelCooldowns(now);
  }
}

function weightedChoice(
  candidates: ScoredCandidate[],
  random: () => number
): PrimaryCandidate {
  const minScore = Math.min(...candidates.map((candidate) => candidate.score));
  const weights = candidates.map((candidate) => Math.max(1, candidate.score - minScore + 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (let index = 0; index < candidates.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) {
      return candidates[index].candidate;
    }
  }

  return candidates[0].candidate;
}
