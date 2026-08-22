import { createHash } from "node:crypto";
import type { BufferedUpstreamResult } from "./upstream-client.js";
import { decodeBodyText } from "./http-utils.js";
import { providerStateErrorCode } from "./provider-state-portability.js";

export interface ProviderStateTargetScope {
  targetStateDomain: string;
  model: string | null;
  endpoint: string | null;
}

export const PROVIDER_STATE_TARGET_HEALTH_TTL_MS = 15 * 60 * 1000;
export const PROVIDER_STATE_LEGACY_FAILURE_TTL_MS = 10 * 60 * 1000;
export const PROVIDER_STATE_LEGACY_FAILURE_THRESHOLD = 2;

export function providerStateTargetHealthKey(scope: ProviderStateTargetScope): string {
  return hashEvidenceKey("target_health", [
    scope.targetStateDomain,
    scope.model ?? "",
    scope.endpoint ?? ""
  ]);
}

/**
 * Counts "this conversation failed against this target the same way again". The
 * failure *mode* discriminates, deliberately not the response bytes: real error
 * bodies carry a per-request id, so hashing them gave every attempt a fresh key
 * and the two-strike threshold could never be reached — the recovery path this
 * evidence gates was unreachable in production while passing its unit tests on
 * synthetic identical bodies.
 */
export function providerStateLegacyFailureKey(
  scope: ProviderStateTargetScope,
  conversationHash: string,
  result: BufferedUpstreamResult
): string {
  return hashEvidenceKey("legacy_failure", [
    conversationHash,
    scope.targetStateDomain,
    scope.model ?? "",
    scope.endpoint ?? "",
    String(result.status),
    providerStateErrorCode(result.status, result.responseBody) ?? ""
  ]);
}

export function isEligibleGenericProviderStateFailure(
  result: BufferedUpstreamResult,
  afterErrorSpecificRepair = false
): boolean {
  if (result.responseBodyTruncated) {
    return false;
  }
  if (providerStateErrorCode(result.status, result.responseBody)) {
    return afterErrorSpecificRepair;
  }
  if (![400, 409, 422, 502].includes(result.status)) {
    return false;
  }

  const summary = `${result.errorSummary ?? ""}\n${decodeBodyText(result.responseBody)}`.toLowerCase();
  if ([
    "invalid api key",
    "invalid_api_key",
    "invalid token",
    "unauthorized",
    "authentication",
    "auth token",
    "api key is invalid",
    "insufficient balance",
    "insufficient_quota",
    "quota exceeded",
    "credit balance",
    "billing",
    "account balance",
    "out of credits",
    "rate_limit",
    "rate limit",
    "too many requests",
    "method not allowed"
  ].some((pattern) => summary.includes(pattern))) {
    return false;
  }

  return !isUnavailableResourceFailure(summary, "model") &&
    !isUnavailableResourceFailure(summary, "endpoint");
}

function isUnavailableResourceFailure(summary: string, resource: "model" | "endpoint"): boolean {
  return summary.includes(resource) && [
    "not found",
    "does not exist",
    "unavailable",
    "unsupported",
    "not supported",
    "invalid",
    "unknown"
  ].some((pattern) => summary.includes(pattern));
}

function hashEvidenceKey(kind: string, parts: string[]): string {
  const hash = createHash("sha256").update(kind);
  for (const part of parts) {
    hash.update("\0").update(part);
  }
  return `sha256:${hash.digest("hex")}`;
}
