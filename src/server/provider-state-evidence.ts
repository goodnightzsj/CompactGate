import { createHash } from "node:crypto";
import type { BufferedUpstreamResult } from "./upstream-client.js";
import { decodeBodyText, isRecord, parseJsonRecord } from "./http-utils.js";
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

  return !isUnavailableResourceFailure(summary, result);
}

/**
 * Matched against the upstream's error *code* rather than its prose. A code is a
 * single short token, so co-occurrence carries no risk there and the separator is
 * whatever the provider chose — `model_not_found`, `unsupported-endpoint`,
 * `invalidModel`. Enumerating the codes missed whichever spelling was not on the
 * list.
 */
const RESOURCE_UNAVAILABLE_CODE = new RegExp([
  "(?:model|endpoint)[ _-]?(?:not[ _-]?found|not[ _-]?supported|unsupported|invalid|unknown|does[ _-]?not[ _-]?exist)",
  "|(?:no[ _-]?such|unknown|unsupported|invalid|nonexistent|missing)[ _-]?(?:model|endpoint)"
].join(""), "i");

/**
 * The resource word and the unavailability word have to be *attached to each
 * other* — at most one identifier token apart — not merely present somewhere in
 * the same response.
 *
 * A bag-of-words match over `errorSummary + whole body` excluded exactly the
 * failures this layer exists for. A request always names a model and relays
 * routinely echo it, so `502 "bad gateway while calling model gpt-5.6-sol;
 * upstream unavailable"` and `400 "Invalid 'input[59].encrypted_content' for model
 * gpt-5.6-sol"` both read as "the model is unavailable": `startGenericRecovery`
 * returned null, and the request died with the raw upstream error instead of
 * getting a CPA or a strict retry. Same failure shape as hashing the response body
 * for the legacy key — green on synthetic fixtures, dead on real bodies.
 *
 * The identifier token may contain dots, because model ids do (`gpt-4.1`); what
 * must not appear between the two is punctuation joining separate clauses. Erring
 * toward not-excluding is the safe direction: a wrong exclusion means recovery
 * never runs at all, while a wrong inclusion costs one attempt that then fails the
 * same way.
 */
const RESOURCE_UNAVAILABLE_PHRASE = new RegExp([
  "(?:model|endpoint)\\s*(?:['\"`]?[\\w.:/-]+['\"`]?\\s*)?(?:is\\s+|was\\s+)?",
  "(?:not found|does not exist|unavailable|unsupported|not supported|invalid|unknown)",
  "|(?:no such|unknown|unsupported|invalid|nonexistent)\\s+(?:model|endpoint)"
].join(""));

function isUnavailableResourceFailure(summary: string, result: BufferedUpstreamResult): boolean {
  const code = readUpstreamErrorCode(result.responseBody);
  if (code && RESOURCE_UNAVAILABLE_CODE.test(code)) {
    return true;
  }

  return RESOURCE_UNAVAILABLE_PHRASE.test(summary);
}

function readUpstreamErrorCode(responseBody: Buffer): string | null {
  const parsed = parseJsonRecord(responseBody);
  const error = isRecord(parsed?.error) ? parsed.error : null;
  for (const candidate of [error?.code, error?.type, parsed?.code, parsed?.type]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase();
    }
  }
  return null;
}

function hashEvidenceKey(kind: string, parts: string[]): string {
  const hash = createHash("sha256").update(kind);
  for (const part of parts) {
    hash.update("\0").update(part);
  }
  return `sha256:${hash.digest("hex")}`;
}
