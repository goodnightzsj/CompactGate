import type { BufferedUpstreamResult } from "./upstream-client.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";
import { classifyProviderStateFailure, type ProviderStateFailure } from "./provider-state-errors.js";
import {
  analyzeProviderState,
  compileProviderStateAttempt,
  hashProviderStateBody,
  lowerFidelity,
  failureTargetsCompaction,
  recoverCompactionItemIds,
  stripCompactionItemIds,
  ProviderStateRecoveryUnavailableError,
  type CompileProviderStateOptions,
  type CompiledProviderStateAttempt,
  type ProviderStateBaseStrategy,
  type ProviderStateErrorCode,
  type ProviderStateFidelity,
  type ProviderStateStrategy
} from "./provider-state-portability.js";
import type { ProviderStateRecoveryPolicy } from "./provider-state-recovery-store.js";
import { isEligibleGenericProviderStateFailure } from "./provider-state-evidence.js";

export type ProviderStateRecoveryTrigger =
  | "explicit_400"
  | "profile_switch_failure"
  | "legacy_failure_threshold"
  | "cached_recovery";

export interface ProviderStateMigrationAttempt {
  strategy: ProviderStateStrategy;
  bodyHash: string;
  status: number;
  errorCode: ProviderStateErrorCode | null;
  compiled: CompiledProviderStateAttempt;
}

export interface ProviderStateMigrationResult {
  result: BufferedUpstreamResult;
  body: Buffer;
  attempts: ProviderStateMigrationAttempt[];
  trigger: ProviderStateRecoveryTrigger | null;
  unavailable?: boolean;
  policy?: ProviderStateRecoveryPolicy;
}

interface RunProviderStateMigrationOptions {
  canonicalBody: Buffer;
  canonicalFidelity?: ProviderStateFidelity;
  targetStateDomain: string;
  recoverCompaction?: CompileProviderStateOptions["recoverCompaction"];
  cachedPolicy?: ProviderStateRecoveryPolicy | null;
  canReplay: () => boolean;
  startGenericRecovery: (
    result: BufferedUpstreamResult,
    afterErrorSpecificRepair: boolean
  ) => Exclude<ProviderStateRecoveryTrigger, "explicit_400"> | null;
  send: (
    body: Buffer,
    strategy: ProviderStateStrategy,
    priorStrategy: ProviderStateBaseStrategy,
    compiled: CompiledProviderStateAttempt,
    recoverySource: "cached" | "recovered" | null
  ) => Promise<BufferedUpstreamResult>;
}

const MAX_PROVIDER_STATE_ATTEMPTS = 4;

export async function runProviderStateMigration(
  options: RunProviderStateMigrationOptions
): Promise<ProviderStateMigrationResult> {
  const canonicalHasCompaction = analyzeProviderState(options.canonicalBody).compactionItemCount > 0;
  const attemptedBodyHashes = new Set<string>();
  const attemptedStrategies = new Set<ProviderStateStrategy>();
  const attempts: ProviderStateMigrationAttempt[] = [];
  let finalResult: BufferedUpstreamResult | null = null;
  let finalBody = options.canonicalBody;
  const cached = options.cachedPolicy;
  let strategy: ProviderStateStrategy = cached?.failure ? "error_400" : cached?.base ?? "original";
  let priorStrategy: ProviderStateBaseStrategy = cached?.base ?? "original";
  let errorCode: ProviderStateErrorCode | undefined = cached?.failure?.code ?? undefined;
  let trigger: ProviderStateRecoveryTrigger | null = cached ? "cached_recovery" : null;
  let genericRecoveryStarted = false;
  let genericRecoveryEvaluated = false;
  let resourceRepair = cached?.stripCompactionIds ? stripCompactionItemIds(options.canonicalBody) : null;
  let failure: ProviderStateFailure | undefined = cached?.failure ?? undefined;
  let rejectedCompaction = cached?.rejectedCompaction ?? false;
  let checkpointRecovery = cached?.checkpointRecovery;
  const priorEncryptedFailures = [...cached?.priorEncryptedFailures ?? []];
  const finish = (unavailable = false): ProviderStateMigrationResult => {
    if (!finalResult) throw new Error("Provider-state recovery produced no upstream attempt.");
    return { result: finalResult, body: finalBody, attempts, trigger, ...(unavailable ? { unavailable } : {}), policy: {
      base: strategy === "error_400" ? priorStrategy : strategy,
      failure: failure ?? null,
      stripCompactionIds: resourceRepair !== null,
      priorEncryptedFailures, rejectedCompaction, checkpointRecovery, unavailable
    } };
  };

  while (attempts.length < MAX_PROVIDER_STATE_ATTEMPTS) {
    let compiled: CompiledProviderStateAttempt;
    try {
      compiled = compileProviderStateAttempt(resourceRepair?.body ?? options.canonicalBody, {
        strategy, priorStrategy, errorCode, failure, rejectedCompaction, priorEncryptedFailures, checkpointRecovery,
        allowCompactionDrop: attempts.length > 0,
        targetStateDomain: options.targetStateDomain,
        recoverCompaction: options.recoverCompaction
      });
    } catch (error) {
      if (!(error instanceof ProviderStateRecoveryUnavailableError)) throw error;
      if (finalResult) return finish(true);
      // Cached repairs are hints, not a reason to block a fresh upstream attempt.
      strategy = priorStrategy = "original";
      errorCode = undefined;
      failure = undefined;
      rejectedCompaction = false;
      checkpointRecovery = undefined;
      priorEncryptedFailures.length = 0;
      resourceRepair = null;
      trigger = null;
      continue;
    }
    compiled.fidelity = lowerFidelity(options.canonicalFidelity ?? "exact", compiled.fidelity);
    if (resourceRepair) compiled.metrics.providerItemIdsRemoved += resourceRepair.removedIds;
    attemptedStrategies.add(strategy);
    if (attemptedBodyHashes.has(compiled.bodyHash)) {
      if (finalResult && strategy === "error_400" && !resourceRepair && !genericRecoveryEvaluated) {
        genericRecoveryEvaluated = true;
        const genericTrigger = options.startGenericRecovery(finalResult, true);
        if (genericTrigger) {
          trigger ??= genericTrigger;
          genericRecoveryStarted = true;
        }
      }
      const next = nextStrategyAfterDuplicate(strategy, genericRecoveryStarted, attemptedStrategies);
      if (!next) {
        break;
      }
      strategy = next;
      priorStrategy = next;
      errorCode = undefined;
      continue;
    }

    attemptedBodyHashes.add(compiled.bodyHash);
    const appliedRepair = compiled.body !== options.canonicalBody || strategy === "cross_domain" || priorStrategy === "cross_domain";
    const recoverySource = attempts.length === 0 && trigger === "cached_recovery" ? "cached" : "recovered";
    const result = await options.send(compiled.body, strategy, priorStrategy, compiled, appliedRepair ? recoverySource : null);
    finalResult = result;
    finalBody = compiled.body;
    const responseFailure = result.deferredProviderStateFailure ?? classifyProviderStateFailure(result.status, result.responseBody, result.responseHeaders);
    const responseErrorCode = responseFailure?.code ?? null;
    attempts.push({
      strategy,
      bodyHash: compiled.bodyHash,
      status: result.status,
      errorCode: responseErrorCode,
      compiled
    });

    if (result.status < 400 && !responseFailure || result.responseBodyTruncated || !options.canReplay()) {
      return finish();
    }

    const located = locateFailure(compiled.body, responseFailure);
    if (responseFailure?.contentIndex !== undefined && located.length === 0) return finish();
    const idRepair = recoverCompactionItemIds(compiled.body, responseFailure);
    if (idRepair) {
      if (resourceRepair || idRepair.removedIds === 0 ||
        (responseFailure?.kind === "resource_mismatch" && strategy !== "original") ||
        !options.canReplay()) {
        return finish();
      }
      resourceRepair = stripCompactionItemIds(options.canonicalBody);
      trigger ??= "explicit_400";
      if (strategy !== "error_400") priorStrategy = strategy;
      strategy = "error_400";
      continue;
    }

    if (
      responseErrorCode === "invalid_responses_request" &&
      (!canonicalHasCompaction ||
        (strategy === "error_400" && errorCode === "invalid_responses_request"))
    ) {
      return finish();
    }

    const compactionOnlyFailure = responseErrorCode === "invalid_encrypted_content" &&
      responseFailure?.itemId == null && responseFailure?.inputIndex == null && responseFailure?.encryptedContentHash == null &&
      failureTargetsCompaction(parseJsonRecord(compiled.body) ?? {}, responseFailure ?? undefined);
    if (responseErrorCode) {
      if (responseErrorCode === "previous_response_not_found") checkpointRecovery = "continuation";
      else if (checkpointRecovery !== "continuation" && responseErrorCode === "invalid_responses_request") {
        checkpointRecovery = "compaction";
      }
      trigger ??= "explicit_400";
      if (strategy !== "error_400") priorStrategy = strategy;
      if (errorCode === "invalid_encrypted_content" && failure) priorEncryptedFailures.push(failure);
      strategy = "error_400";
      errorCode = responseErrorCode;
      failure = located.pop();
      priorEncryptedFailures.push(...located);
      rejectedCompaction ||= compactionOnlyFailure;
      continue;
    }

    // A resource-ID experiment can continue only for an explicit state failure, never a generic destructive fallback.
    if (resourceRepair) return finish();
    if (genericRecoveryStarted && !isEligibleGenericProviderStateFailure(result)) return finish();

    if (!genericRecoveryStarted && !genericRecoveryEvaluated) {
      genericRecoveryEvaluated = true;
      const genericTrigger = options.startGenericRecovery(result, strategy === "error_400");
      if (genericTrigger) {
        trigger ??= genericTrigger;
        genericRecoveryStarted = true;
      }
    }

    const next = nextStrategyAfterFailure(strategy, genericRecoveryStarted, attemptedStrategies);
    if (!next) {
      return finish();
    }
    strategy = next;
    priorStrategy = next;
    errorCode = undefined;
  }

  return finish();
}

function locateFailure(body: Buffer, failure: ProviderStateFailure | null): ProviderStateFailure[] {
  if (!failure) return [];
  const stable = { ...failure, itemId: null, inputIndex: null, contentIndex: undefined };
  const input = parseJsonRecord(body)?.input;
  const item = Array.isArray(input) ? failure.inputIndex !== null ? input[failure.inputIndex]
    : input.find(item => isRecord(item) && failure.itemId !== null && item.id === failure.itemId) : null;
  if (failure.contentIndex !== undefined) {
    const block = isRecord(item) && item.type === "agent_message" && Array.isArray(item.content) ? item.content[failure.contentIndex] : null;
    if (!isRecord(block) || block.type !== "encrypted_content" || typeof block.encrypted_content !== "string") return [];
  }
  if (failure.encryptedContentHash) return [stable];
  if (!isRecord(item)) return [failure];
  const blocks = item.type === "agent_message" && Array.isArray(item.content)
    ? failure.contentIndex === undefined ? item.content : [item.content[failure.contentIndex]] : [];
  const ciphertexts = blocks.filter(block => isRecord(block) && block.type === "encrypted_content")
    .map(block => block.encrypted_content).filter((value): value is string => typeof value === "string");
  if (failure.contentIndex === undefined && typeof item.encrypted_content === "string") ciphertexts.push(item.encrypted_content);
  // Resolve coordinates against the sent body before rebuilding from the immutable original.
  return ciphertexts.length ? ciphertexts.map(value => ({ ...stable, encryptedContentHash: hashProviderStateBody(Buffer.from(value)) }))
    : [typeof item.id === "string" ? { ...failure, itemId: item.id, inputIndex: null }
      : { ...stable, inputItemHash: hashProviderStateBody(Buffer.from(JSON.stringify(item))) }];
}

function nextStrategyAfterFailure(
  strategy: ProviderStateStrategy,
  genericRecoveryStarted: boolean,
  attempted: Set<ProviderStateStrategy>
): ProviderStateBaseStrategy | null {
  if (!genericRecoveryStarted) {
    return null;
  }
  if (strategy === "original" && !attempted.has("cpa")) {
    return "cpa";
  }
  if (strategy !== "cross_domain" && !attempted.has("cross_domain")) {
    return "cross_domain";
  }
  return null;
}

function nextStrategyAfterDuplicate(
  strategy: ProviderStateStrategy,
  genericRecoveryStarted: boolean,
  attempted: Set<ProviderStateStrategy>
): ProviderStateBaseStrategy | null {
  if (!genericRecoveryStarted) {
    return null;
  }
  if ((strategy === "cpa" || strategy === "error_400") && !attempted.has("cross_domain")) {
    return "cross_domain";
  }
  return null;
}
