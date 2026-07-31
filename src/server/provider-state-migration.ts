import type { BufferedUpstreamResult } from "./upstream-client.js";
import {
  compileProviderStateAttempt,
  providerStateErrorCode,
  type CompiledProviderStateAttempt,
  type ProviderStateBaseStrategy,
  type ProviderStateErrorCode,
  type ProviderStateStrategy
} from "./provider-state-portability.js";

export type ProviderStateRecoveryTrigger =
  | "explicit_400"
  | "profile_switch_failure"
  | "legacy_failure_threshold";

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
}

interface RunProviderStateMigrationOptions {
  canonicalBody: Buffer;
  targetStateDomain: string;
  canReplay: () => boolean;
  startGenericRecovery: (
    result: BufferedUpstreamResult,
    afterErrorSpecificRepair: boolean
  ) => Exclude<ProviderStateRecoveryTrigger, "explicit_400"> | null;
  send: (
    body: Buffer,
    strategy: ProviderStateStrategy,
    priorStrategy: ProviderStateBaseStrategy
  ) => Promise<BufferedUpstreamResult>;
}

const MAX_PROVIDER_STATE_ATTEMPTS = 4;

export async function runProviderStateMigration(
  options: RunProviderStateMigrationOptions
): Promise<ProviderStateMigrationResult> {
  const attemptedBodyHashes = new Set<string>();
  const attemptedStrategies = new Set<ProviderStateStrategy>();
  const attempts: ProviderStateMigrationAttempt[] = [];
  let finalResult: BufferedUpstreamResult | null = null;
  let finalBody = options.canonicalBody;
  let strategy: ProviderStateStrategy = "original";
  let priorStrategy: ProviderStateBaseStrategy = "original";
  let errorCode: ProviderStateErrorCode | undefined;
  let trigger: ProviderStateRecoveryTrigger | null = null;
  let genericRecoveryStarted = false;
  let genericRecoveryEvaluated = false;

  while (attempts.length < MAX_PROVIDER_STATE_ATTEMPTS) {
    const compiled = compileProviderStateAttempt(options.canonicalBody, {
      strategy,
      priorStrategy,
      errorCode,
      targetStateDomain: options.targetStateDomain
    });
    attemptedStrategies.add(strategy);
    if (attemptedBodyHashes.has(compiled.bodyHash)) {
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
    const result = await options.send(compiled.body, strategy, priorStrategy);
    finalResult = result;
    finalBody = compiled.body;
    const responseErrorCode = providerStateErrorCode(result.status, result.responseBody);
    attempts.push({
      strategy,
      bodyHash: compiled.bodyHash,
      status: result.status,
      errorCode: responseErrorCode,
      compiled
    });

    if (result.status < 400 || !options.canReplay()) {
      return { result, body: compiled.body, attempts, trigger };
    }

    if (responseErrorCode && strategy !== "error_400") {
      trigger ??= "explicit_400";
      priorStrategy = strategy;
      strategy = "error_400";
      errorCode = responseErrorCode;
      continue;
    }

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
      return { result, body: compiled.body, attempts, trigger };
    }
    strategy = next;
    priorStrategy = next;
    errorCode = undefined;
  }

  if (!finalResult) {
    throw new Error("Provider-state recovery produced no upstream attempt.");
  }
  return {
    result: finalResult,
    body: finalBody,
    attempts,
    trigger
  };
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
