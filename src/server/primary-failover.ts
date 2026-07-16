import type { CompactGateConfig } from "../shared/types.js";
import {
  candidateSignature,
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
import { selectPrimaryCandidate } from "./primary-failover-policy.js";
import { PrimaryStickinessStore } from "./primary-failover-stickiness.js";
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

const FAILOVER_FAILURE_THRESHOLD = 11;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const TRANSIENT_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const ACCOUNT_QUARANTINE_MS = 30 * 60 * 1000;
const MODEL_DISABLE_MS = 12 * 60 * 60 * 1000;

interface PrimaryFailoverOptions {
  now?: () => number;
  random?: () => number;
  maxStickyEntries?: number;
  maxModelCooldownEntries?: number;
}

export class PrimaryFailoverState {
  private signature = "";
  private generation = 0;
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
          health.authFailures = 0;
          health.quotaFailures = 0;
          health.transientFailures = 0;
          health.emptyStreamFailures = 0;
          health.rateLimitFailures = 0;
          health.modelIncompatibleFailuresByModel.clear();
          health.cooldownUntil = 0;
          health.rateLimitUntil = 0;
          health.version += 1;
        }
        this.rememberResponseStickiness(selection, result, now);
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

  getHealthSnapshot(): PrimaryProfileHealthSnapshot[] {
    return this.health.snapshot();
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

    const signature = candidateSignature(candidates);
    if (signature !== this.signature) {
      this.signature = signature;
      this.generation += 1;
      this.health.clear();
      this.stickiness.clear();
    }

    this.health.reconcile(candidates);

    if (!config.primary_failover.auto_schedule) {
      const selected = candidates.find((candidate) => candidate.active) ?? candidates[0];
      const health = this.health.forProfile(selected.id);
      const selection = {
        config: selected.config,
        profileId: selected.id,
        profileName: selected.name,
        generation: this.generation,
        healthVersion: health.version,
        context: normalizedContext
      };
      if (reserve) {
        this.reserveSelection(selection, false);
      }
      return selection;
    }

    const now = this.now();
    this.cleanupExpiredState(now);

    const selected = selectPrimaryCandidate({
      candidates,
      context: normalizedContext,
      now,
      random: this.random,
      healthForProfile: (profileId) => this.health.forProfile(profileId),
      blockedUntil: (candidate, candidateContext, candidateNow) =>
        this.blockedUntil(candidate, candidateContext, candidateNow),
      stickyProfileId: (isUsable) =>
        this.stickiness.selectProfileId(normalizedContext, isUsable)
    });
    const health = this.health.forProfile(selected.id);
    const selection = {
      config: selected.config,
      profileId: selected.id,
      profileName: selected.name,
      generation: this.generation,
      healthVersion: health.version,
      context: normalizedContext
    };
    if (reserve) {
      this.reserveSelection(selection, true);
    }
    return selection;
  }

  private blockedUntil(
    candidate: PrimaryCandidate,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): number {
    return this.health.blockedUntil(candidate.id, context.model, now);
  }

  private cleanupExpiredState(now: number): void {
    this.stickiness.cleanup(now);
    this.health.cleanupExpiredModelCooldowns(now);
  }

  private rememberResponseStickiness(
    selection: PrimaryRouteSelection,
    result: PrimaryRouteResult,
    now: number
  ): void {
    this.stickiness.rememberResponse(selection, result, now);
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
