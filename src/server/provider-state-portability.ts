import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { synthesizeAssistantMessage } from "./compaction-bridge.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";
import { classifyProviderStateFailure, type ProviderStateErrorCode, type ProviderStateFailure } from "./provider-state-errors.js";
export type { ProviderStateErrorCode } from "./provider-state-errors.js";

export type ProviderStateStrategy = "original" | "cpa" | "cross_domain" | "error_400";
export type ProviderStateBaseStrategy = Exclude<ProviderStateStrategy, "error_400">;
export type ProviderStateFidelity = "exact" | "summary" | "degraded";

export interface ProviderStateAnalysis {
  reasoningItemCount: number;
  encryptedReasoningItemCount: number;
  invalidEncryptedReasoningItemCount: number;
  encryptedAgentMessageCount: number;
  encryptedNonCompactionItemCount: number;
  compactionItemCount: number;
  previousResponseIdPresent: boolean;
  hasProviderOwnedState: boolean;
}

export interface ProviderStateMetrics {
  encryptedReasoningFieldsRemoved: number;
  encryptedAgentMessageBlocksRemoved: number;
  encryptedReplayFieldsRemoved: number;
  nullReasoningContentFieldsRemoved: number;
  reasoningItemsRemoved: number;
  compactionItemsReplaced: number;
  compactionItemsRemoved: number;
  previousResponseIdsRemoved: number;
  providerItemIdsRemoved: number;
  privateMetadataFieldsRemoved: number;
  orphanToolItemsRemoved: number;
}

export interface CompileProviderStateOptions {
  strategy: ProviderStateStrategy;
  priorStrategy?: ProviderStateBaseStrategy;
  errorCode?: ProviderStateErrorCode;
  targetStateDomain?: string;
  failure?: ProviderStateFailure;
  rejectedCompaction?: boolean;
  priorEncryptedFailures?: ProviderStateFailure[];
  /** Only the coordinator may enable loss after a fresh upstream rejection, never from cache alone. */
  allowCompactionDrop?: boolean;
  recoverCompaction?: (body: Buffer) => { body: Buffer; fidelity: ProviderStateFidelity } | null;
}

export class ProviderStateRecoveryUnavailableError extends Error {
  readonly status = 422;
  readonly code = "provider_state_unrecoverable";
  constructor() {
    super("The rejected provider state has no complete recovery checkpoint or readable summary. The encrypted context was preserved; restore the original provider or supply the missing conversation history.");
    this.name = "ProviderStateRecoveryUnavailableError";
  }
}

export interface CompiledProviderStateAttempt {
  body: Buffer;
  bodyHash: string;
  fidelity: ProviderStateFidelity;
  metrics: ProviderStateMetrics;
}

const MAX_ENCRYPTED_CONTENT_LENGTH = 32 * 1024 * 1024;
const FERNET_FIXED_BYTES = 57;
const FERNET_MINIMUM_BYTES = FERNET_FIXED_BYTES + 16;

export function analyzeProviderState(body: Buffer): ProviderStateAnalysis {
  const parsed = parseJsonRecord(body);
  const input = Array.isArray(parsed?.input) ? parsed.input : [];
  let reasoningItemCount = 0;
  let encryptedReasoningItemCount = 0;
  let invalidEncryptedReasoningItemCount = 0;
  let compactionItemCount = 0;
  let encryptedAgentMessageCount = 0;
  let encryptedNonCompactionItemCount = 0;

  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type !== "compaction" && hasEncryptedProviderState(item)) encryptedNonCompactionItemCount += 1;

    if (item.type === "reasoning") {
      reasoningItemCount += 1;
      if (Object.hasOwn(item, "encrypted_content")) {
        encryptedReasoningItemCount += 1;
        invalidEncryptedReasoningItemCount += isValidGptReasoningEncryptedContent(
          item.encrypted_content
        ) ? 0 : 1;
      }
    } else if (item.type === "compaction") {
      compactionItemCount += 1;
    } else if (item.type === "agent_message" && Array.isArray(item.content) &&
      item.content.some(isEncryptedContentBlock)) {
      encryptedAgentMessageCount += 1;
    }
  }

  const previousResponseIdPresent = Boolean(
    parsed && (Object.hasOwn(parsed, "previous_response_id") || Object.hasOwn(parsed, "previousResponseId"))
  );

  return {
    reasoningItemCount,
    encryptedReasoningItemCount,
    invalidEncryptedReasoningItemCount,
    encryptedAgentMessageCount,
    encryptedNonCompactionItemCount,
    compactionItemCount,
    previousResponseIdPresent,
    hasProviderOwnedState:
      reasoningItemCount > 0 || compactionItemCount > 0 || encryptedNonCompactionItemCount > 0 || previousResponseIdPresent
  };
}

// This validates only the GPT/Fernet transport envelope. It cannot prove that the target can decrypt it.
export function isValidGptReasoningEncryptedContent(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ENCRYPTED_CONTENT_LENGTH ||
    value.trim() !== value ||
    !value.startsWith("gAAAA") ||
    !/^[A-Za-z0-9_=-]+$/.test(value)
  ) {
    return false;
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return false;
  }

  const encryptedBytes = decoded.byteLength - FERNET_FIXED_BYTES;
  return (
    decoded.byteLength >= FERNET_MINIMUM_BYTES &&
    decoded[0] === 0x80 &&
    encryptedBytes > 0 &&
    encryptedBytes % 16 === 0
  );
}

export function compileProviderStateAttempt(
  canonicalBody: Buffer,
  options: CompileProviderStateOptions
): CompiledProviderStateAttempt {
  if (options.strategy === "original") {
    return unchangedResult(canonicalBody);
  }

  let parsed = parseJsonRecord(canonicalBody);
  if (!parsed) {
    return unchangedResult(canonicalBody);
  }
  const crossDomain = options.strategy === "cross_domain" || options.strategy === "error_400" && options.priorStrategy === "cross_domain";
  const allowCompactionDrop = options.allowCompactionDrop === true && options.strategy === "error_400" &&
    !crossDomain && options.errorCode === "invalid_encrypted_content";
  if (options.strategy === "error_400" && options.errorCode === "invalid_encrypted_content" &&
    !crossDomain && hasFailureLocator(options.failure) && !options.rejectedCompaction &&
    (!Array.isArray(parsed.input) || !parsed.input.some((item, index) => matchesFailureTarget(item, index, options.failure)))) {
    return unchangedResult(canonicalBody);
  }

  const metrics = emptyMetrics();
  let fidelity: ProviderStateFidelity = "exact";
  const targetsCompaction = crossDomain || options.errorCode === "invalid_responses_request" ||
    options.errorCode === "invalid_encrypted_content" && (options.rejectedCompaction || failureTargetsCompaction(parsed, options.failure));
  const requiresContinuation = options.errorCode === "previous_response_not_found" || crossDomain &&
    (parsed.previous_response_id != null || parsed.previousResponseId != null);
  if ((targetsCompaction || requiresContinuation) && options.recoverCompaction) {
    const recovered = options.recoverCompaction(canonicalBody);
    if (recovered) {
      const restored = parseJsonRecord(recovered.body);
      if (!restored) throw new ProviderStateRecoveryUnavailableError();
      metrics.compactionItemsReplaced = analyzeProviderState(canonicalBody).compactionItemCount - analyzeProviderState(recovered.body).compactionItemCount;
      const original = parsed;
      metrics.previousResponseIdsRemoved = ["previous_response_id", "previousResponseId"].filter(key => Object.hasOwn(original, key) && !Object.hasOwn(restored, key)).length;
      parsed = restored;
      fidelity = recovered.fidelity;
    }
  }
  if (requiresContinuation && (parsed.previous_response_id != null || parsed.previousResponseId != null)) throw new ProviderStateRecoveryUnavailableError();

  if (options.strategy === "cpa") {
    applyCpaCleanup(parsed, metrics);
  } else if (options.strategy === "cross_domain") {
    fidelity = lowerFidelity(fidelity, applyCrossDomainCleanup(parsed, metrics, options.targetStateDomain));
  } else {
    if (options.priorStrategy === "cross_domain") {
      fidelity = lowerFidelity(fidelity, applyCrossDomainCleanup(parsed, metrics, options.targetStateDomain));
    } else if (options.priorStrategy === "cpa") {
      applyCpaCleanup(parsed, metrics);
    }
    for (const prior of options.priorEncryptedFailures ?? []) {
      if (failureTargetsCompaction(parsed, prior)) {
        fidelity = lowerFidelity(fidelity, recoverRejectedCompactions(parsed, metrics, prior, allowCompactionDrop));
      } else applyErrorRecovery(parsed, metrics, "invalid_encrypted_content", prior);
    }
    if (targetsCompaction) {
      fidelity = lowerFidelity(fidelity, recoverRejectedCompactions(parsed, metrics, options.rejectedCompaction ? undefined : options.failure, allowCompactionDrop));
    } else {
      applyErrorRecovery(parsed, metrics, options.errorCode, options.failure);
    }
  }
  if (metrics.encryptedAgentMessageBlocksRemoved > 0 || metrics.encryptedReasoningFieldsRemoved > 0 ||
    metrics.encryptedReplayFieldsRemoved > 0 || metrics.reasoningItemsRemoved > 0) {
    fidelity = "degraded";
  }

  const changed = hasChanges(metrics) || hasPromptCacheKeyRewrite(canonicalBody, parsed);
  if (!changed) {
    return unchangedResult(canonicalBody, metrics, fidelity);
  }

  const body = Buffer.from(JSON.stringify(parsed));
  return {
    body,
    bodyHash: hashProviderStateBody(body),
    fidelity,
    metrics
  };
}

export function providerStateErrorCode(
  status: number,
  responseBody: Buffer,
  responseHeaders: IncomingHttpHeaders = {}
): ProviderStateErrorCode | null {
  return classifyProviderStateFailure(status, responseBody, responseHeaders)?.code ?? null;
}

export function hashProviderStateBody(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A resource mismatch with no safe ID removal still stops broader state cleanup. */
export function recoverCompactionItemIds(
  body: Buffer, failure: ProviderStateFailure | null
): { body: Buffer; removedIds: number } | null {
  if (failure?.kind === "resource_mismatch") return stripCompactionItemIds(body);
  const parsed = parseJsonRecord(body);
  if (failure?.kind !== "encrypted_content" || !parsed || !failureTargetsCompaction(parsed, failure)) return null;
  // A rejected compaction ID does not prove its ciphertext is unusable without the ID.
  const repair = stripCompactionItemIds(body);
  return repair.removedIds > 0 ? repair : null;
}

export function stripCompactionItemIds(body: Buffer): { body: Buffer; removedIds: number } {
  const unchanged = { body, removedIds: 0 };
  const parsed = parseJsonRecord(body);
  if (!parsed || parsed.store !== false || !Array.isArray(parsed.input) || hasStoredProviderStateReferences(parsed)) {
    return unchanged;
  }

  // Captures show successful V2 output rejected on the next turn with only its
  // compaction.id left. Preserve its opaque context during this ID-only attempt.
  let removedIds = 0;
  for (const item of parsed.input) {
    if (isRecord(item) && item.type === "compaction" && typeof item.id === "string" &&
      typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
      delete item.id;
      removedIds += 1;
    }
  }
  return removedIds > 0 ? { body: Buffer.from(JSON.stringify(parsed)), removedIds } : unchanged;
}

function applyCpaCleanup(
  body: Record<string, unknown>,
  metrics: ProviderStateMetrics
): void {
  if (!Array.isArray(body.input)) {
    return;
  }

  const store = body.store === true;
  for (const item of body.input) {
    if (!isRecord(item) || item.type !== "reasoning") {
      continue;
    }

    const validEncryptedContent = isValidGptReasoningEncryptedContent(item.encrypted_content);
    if (Object.hasOwn(item, "encrypted_content") && !validEncryptedContent) {
      delete item.encrypted_content;
      metrics.encryptedReasoningFieldsRemoved += 1;
    }

    if (!store && !validEncryptedContent && Object.hasOwn(item, "id")) {
      delete item.id;
      metrics.providerItemIdsRemoved += 1;
    }
  }
}

function applyCrossDomainCleanup(
  body: Record<string, unknown>,
  metrics: ProviderStateMetrics,
  targetStateDomain: string | undefined
): ProviderStateFidelity {
  removePreviousResponseIds(body, metrics);
  stripPrivateMetadata(body, metrics);
  rewritePromptCacheKey(body, targetStateDomain);
  removeAgentMessageEncryptedContent(body, metrics);
  removeEncryptedReplayContent(body, metrics);

  const nextInput: unknown[] = [];
  let fidelity: ProviderStateFidelity = "exact";
  if (!Array.isArray(body.input)) {
    return fidelity;
  }

  for (const item of body.input) {
    if (!isRecord(item)) {
      nextInput.push(item);
      continue;
    }

    stripPrivateMetadata(item, metrics);
    if (Array.isArray(item.content)) {
      for (const block of item.content) stripPrivateMetadata(block, metrics);
    }

    if (item.type === "reasoning") {
      metrics.reasoningItemsRemoved += 1;
      fidelity = "degraded";
      continue;
    }

    if (item.type === "compaction") {
      const replacement = typeof item.encrypted_content === "string"
        ? synthesizeAssistantMessage(item.encrypted_content)
        : null;
      if (replacement) {
        nextInput.push(replacement);
        metrics.compactionItemsReplaced += 1;
        if (fidelity === "exact") {
          fidelity = "summary";
        }
      } else throw new ProviderStateRecoveryUnavailableError();
      continue;
    }

    if (item.type === "item_reference" || item.type === undefined && typeof item.id === "string") {
      throw new ProviderStateRecoveryUnavailableError();
    }

    if (Object.hasOwn(item, "id")) {
      delete item.id;
      metrics.providerItemIdsRemoved += 1;
    }
    nextInput.push(item);
  }

  body.input = removeOrphanToolItems(nextInput, metrics);
  if (metrics.orphanToolItemsRemoved > 0) {
    fidelity = "degraded";
  }
  return fidelity;
}

function removeOrphanToolItems(
  input: unknown[],
  metrics: ProviderStateMetrics
): unknown[] {
  const callIds = new Set<string>();
  const outputCallIds = new Set<string>();
  for (const item of input) {
    if (!isRecord(item) || typeof item.call_id !== "string" || item.call_id.length === 0) {
      continue;
    }
    if (isToolCallType(item.type)) {
      callIds.add(item.call_id);
    } else if (isToolOutputType(item.type)) {
      outputCallIds.add(item.call_id);
    }
  }

  return input.filter((item) => {
    if (!isRecord(item)) {
      return true;
    }
    if (isToolCallType(item.type)) {
      const keep = typeof item.call_id === "string" && outputCallIds.has(item.call_id);
      metrics.orphanToolItemsRemoved += keep ? 0 : 1;
      return keep;
    }
    if (isToolOutputType(item.type)) {
      const keep = typeof item.call_id === "string" && callIds.has(item.call_id);
      metrics.orphanToolItemsRemoved += keep ? 0 : 1;
      return keep;
    }
    return true;
  });
}

function isToolCallType(value: unknown): boolean {
  return value === "function_call" || value === "custom_tool_call" || value === "local_shell_call";
}

function isToolOutputType(value: unknown): boolean {
  return value === "function_call_output" ||
    value === "custom_tool_call_output" ||
    value === "local_shell_call_output";
}

function applyErrorRecovery(
  body: Record<string, unknown>,
  metrics: ProviderStateMetrics,
  errorCode: ProviderStateErrorCode | undefined,
  failure?: ProviderStateFailure
): void {
  if (errorCode === "invalid_encrypted_content") {
    removeAgentMessageEncryptedContent(body, metrics, failure);
    removeEncryptedReplayContent(body, metrics, failure);
    if (!Array.isArray(body.input)) {
      return;
    }

    body.input = body.input.filter((item, index) => {
      if (!isRecord(item) || item.type !== "reasoning" || !matchesFailureTarget(item, index, failure)) {
        return true;
      }

      if (Object.hasOwn(item, "encrypted_content")) {
        delete item.encrypted_content;
        metrics.encryptedReasoningFieldsRemoved += 1;
      }
      if (item.content === null) {
        delete item.content;
        metrics.nullReasoningContentFieldsRemoved += 1;
      }
      if (Object.hasOwn(item, "id")) {
        delete item.id;
        metrics.providerItemIdsRemoved += 1;
      }
      if (hasReadableText(item.summary) || hasReadableText(item.content)) return true;
      metrics.reasoningItemsRemoved += 1;
      return false;
    });
  } else if (errorCode === "previous_response_not_found") {
    removePreviousResponseIds(body, metrics);
  }
}

export function failureTargetsCompaction(body: Record<string, unknown>, failure?: ProviderStateFailure): boolean {
  if (!Array.isArray(body.input)) return false;
  if (hasFailureLocator(failure)) return body.input.some((item, index) =>
    isRecord(item) && item.type === "compaction" && matchesFailureTarget(item, index, failure));
  // An abbreviated error does not identify one item. Only infer compaction when it is the sole state carrier.
  return body.input.some(item => isRecord(item) && item.type === "compaction") &&
    !body.input.some(item => isRecord(item) && item.type !== "compaction" && hasEncryptedProviderState(item));
}

export function hasEncryptedProviderState(item: Record<string, unknown>): boolean {
  return Object.hasOwn(item, "encrypted_content") || item.type === "agent_message" &&
    Array.isArray(item.content) && item.content.some(isEncryptedContentBlock);
}

function hasReadableText(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.some(block =>
    isRecord(block) && ["input_text", "output_text", "summary_text", "reasoning_text"].includes(String(block.type)) &&
    typeof block.text === "string" && block.text.trim().length > 0);
}

function hasReplayPayload(item: Record<string, unknown>): boolean {
  switch (item.type) {
    case "message":
    case "agent_message": return hasReadableText(item.content);
    case "web_search_call": return isRecord(item.action) && typeof item.action.type === "string";
    case "function_call": return typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string";
    case "custom_tool_call": return typeof item.call_id === "string" && typeof item.name === "string" && typeof item.input === "string";
    case "function_call_output":
    case "custom_tool_call_output": return typeof item.call_id === "string" && Object.hasOwn(item, "output");
    default: return false;
  }
}

function removeEncryptedReplayContent(
  body: Record<string, unknown>, metrics: ProviderStateMetrics, failure?: ProviderStateFailure
): void {
  if (!Array.isArray(body.input)) return;
  for (const [index, item] of body.input.entries()) {
    if (!isRecord(item) || !Object.hasOwn(item, "encrypted_content") ||
      !matchesFailureTarget(item, index, failure) || !hasReplayPayload(item)) continue;
    if (failure?.encryptedContentHash != null && !ciphertextMatches(item.encrypted_content, failure.encryptedContentHash)) continue;
    // Only protocol replay copies are disposable; never traverse user/tool payloads.
    delete item.encrypted_content;
    metrics.encryptedReplayFieldsRemoved += 1;
  }
}

function hasStoredProviderStateReferences(body: Record<string, unknown>): boolean {
  return body.previous_response_id != null || body.previousResponseId != null || Array.isArray(body.input) &&
    body.input.some(item => isRecord(item) && (item.type === "item_reference" || item.type === undefined && typeof item.id === "string"));
}

function recoverRejectedCompactions(
  body: Record<string, unknown>, metrics: ProviderStateMetrics, failure?: ProviderStateFailure, allowDrop = false
): ProviderStateFidelity {
  if (!Array.isArray(body.input)) return "exact";
  const canDrop = allowDrop && body.store === false && !hasStoredProviderStateReferences(body) &&
    body.input.some(item => isRecord(item) && item.type !== "compaction") &&
    (hasFailureLocator(failure) || body.input.filter(item => isRecord(item) && item.type === "compaction").length === 1);
  let fidelity: ProviderStateFidelity = "exact";
  body.input = body.input.flatMap((item, index) => {
    if (!isRecord(item) || item.type !== "compaction" || !matchesFailureTarget(item, index, failure)) return [item];
    const replacement = typeof item.encrypted_content === "string" ? synthesizeAssistantMessage(item.encrypted_content) : null;
    if (replacement) {
      metrics.compactionItemsReplaced += 1;
      fidelity = lowerFidelity(fidelity, "summary");
      return [replacement];
    }
    if (!canDrop || typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
      throw new ProviderStateRecoveryUnavailableError();
    }
    metrics.compactionItemsRemoved += 1;
    fidelity = "degraded";
    return [];
  });
  return fidelity;
}

function lowerFidelity(left: ProviderStateFidelity, right: ProviderStateFidelity): ProviderStateFidelity {
  return left === "degraded" || right === "degraded" ? "degraded"
    : left === "summary" || right === "summary" ? "summary" : "exact";
}

function hasFailureLocator(failure?: ProviderStateFailure): boolean {
  return failure?.itemId != null || failure?.inputIndex != null || failure?.encryptedContentHash != null;
}

function matchesFailureTarget(item: unknown, index: number, failure?: ProviderStateFailure): boolean {
  if (!hasFailureLocator(failure)) return true;
  if (!isRecord(item)) return false;
  if (failure?.inputIndex != null) return index === failure.inputIndex;
  if (failure?.itemId != null) return item.id === failure.itemId;
  return ciphertextMatches(item.encrypted_content, failure?.encryptedContentHash) || item.type === "agent_message" &&
    Array.isArray(item.content) && item.content.some(block => isRecord(block) && isEncryptedContentBlock(block) &&
      ciphertextMatches(block.encrypted_content, failure?.encryptedContentHash));
}

function ciphertextMatches(value: unknown, hash: string | null | undefined): boolean {
  return typeof value === "string" && hashProviderStateBody(Buffer.from(value)) === hash;
}

function isEncryptedContentBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "encrypted_content";
}

function removeAgentMessageEncryptedContent(
  body: Record<string, unknown>,
  metrics: ProviderStateMetrics,
  failure?: ProviderStateFailure
): void {
  if (!Array.isArray(body.input)) return;
  for (const [index, item] of body.input.entries()) {
    if (!isRecord(item) || item.type !== "agent_message" || !Array.isArray(item.content) || !matchesFailureTarget(item, index, failure)) continue;
    // A ciphertext-only agent message has no safe readable fallback.
    if (!item.content.some((block) => isRecord(block) && block.type === "input_text" &&
      typeof block.text === "string" && block.text.trim().length > 0)) continue;
    const content = item.content.filter((block) => !isEncryptedContentBlock(block) ||
      failure?.encryptedContentHash != null && isRecord(block) && !ciphertextMatches(block.encrypted_content, failure.encryptedContentHash));
    metrics.encryptedAgentMessageBlocksRemoved += item.content.length - content.length;
    item.content = content;
  }
}

function removePreviousResponseIds(
  body: Record<string, unknown>,
  metrics: ProviderStateMetrics
): void {
  for (const key of ["previous_response_id", "previousResponseId"] as const) {
    if (Object.hasOwn(body, key)) {
      delete body[key];
      metrics.previousResponseIdsRemoved += 1;
    }
  }
}

function stripPrivateMetadata(value: unknown, metrics: ProviderStateMetrics): void {
  if (!isRecord(value)) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (key === "_passthrough" || key.startsWith("internal_")) {
      delete value[key];
      metrics.privateMetadataFieldsRemoved += 1;
    }
  }
}

function rewritePromptCacheKey(
  body: Record<string, unknown>,
  targetStateDomain: string | undefined
): void {
  for (const key of ["prompt_cache_key", "promptCacheKey"] as const) {
    const current = body[key];
    if (typeof current !== "string" || current.length === 0) {
      continue;
    }
    const digest = createHash("sha256")
      .update(targetStateDomain ?? "unknown")
      .update("\0")
      .update(current)
      .digest("hex");
    body[key] = `cg:${digest}`;
  }
}

function hasPromptCacheKeyRewrite(
  canonicalBody: Buffer,
  parsed: Record<string, unknown>
): boolean {
  const canonical = parseJsonRecord(canonicalBody);
  return canonical?.prompt_cache_key !== parsed.prompt_cache_key ||
    canonical?.promptCacheKey !== parsed.promptCacheKey;
}

function hasChanges(metrics: ProviderStateMetrics): boolean {
  return Object.values(metrics).some((count) => count > 0);
}

function emptyMetrics(): ProviderStateMetrics {
  return {
    encryptedReasoningFieldsRemoved: 0,
    encryptedAgentMessageBlocksRemoved: 0,
    encryptedReplayFieldsRemoved: 0,
    nullReasoningContentFieldsRemoved: 0,
    reasoningItemsRemoved: 0,
    compactionItemsReplaced: 0,
    compactionItemsRemoved: 0,
    previousResponseIdsRemoved: 0,
    providerItemIdsRemoved: 0,
    privateMetadataFieldsRemoved: 0,
    orphanToolItemsRemoved: 0
  };
}

function unchangedResult(
  canonicalBody: Buffer,
  metrics = emptyMetrics(),
  fidelity: ProviderStateFidelity = "exact"
): CompiledProviderStateAttempt {
  return {
    body: canonicalBody,
    bodyHash: hashProviderStateBody(canonicalBody),
    fidelity,
    metrics
  };
}
