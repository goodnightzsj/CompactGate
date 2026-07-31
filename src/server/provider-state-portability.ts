import { createHash } from "node:crypto";
import { synthesizeAssistantMessage } from "./compaction-bridge.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";

export type ProviderStateStrategy = "original" | "cpa" | "cross_domain" | "error_400";
export type ProviderStateBaseStrategy = Exclude<ProviderStateStrategy, "error_400">;
export type ProviderStateFidelity = "exact" | "summary" | "degraded";
export type ProviderStateErrorCode =
  | "invalid_encrypted_content"
  | "previous_response_not_found";

export interface ProviderStateAnalysis {
  parseable: boolean;
  reasoningItemCount: number;
  encryptedReasoningItemCount: number;
  invalidEncryptedReasoningItemCount: number;
  compactionItemCount: number;
  previousResponseIdPresent: boolean;
  promptCacheKeyPresent: boolean;
  hasProviderOwnedState: boolean;
}

export interface ProviderStateMetrics {
  encryptedReasoningFieldsRemoved: number;
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
}

export interface CompiledProviderStateAttempt {
  body: Buffer;
  bodyHash: string;
  changed: boolean;
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

  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }

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
    }
  }

  const previousResponseIdPresent = Boolean(
    parsed && (Object.hasOwn(parsed, "previous_response_id") || Object.hasOwn(parsed, "previousResponseId"))
  );
  const promptCacheKeyPresent = Boolean(
    parsed && (Object.hasOwn(parsed, "prompt_cache_key") || Object.hasOwn(parsed, "promptCacheKey"))
  );

  return {
    parseable: parsed !== null,
    reasoningItemCount,
    encryptedReasoningItemCount,
    invalidEncryptedReasoningItemCount,
    compactionItemCount,
    previousResponseIdPresent,
    promptCacheKeyPresent,
    hasProviderOwnedState:
      reasoningItemCount > 0 || compactionItemCount > 0 || previousResponseIdPresent
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

  const parsed = parseJsonRecord(canonicalBody);
  if (!parsed) {
    return unchangedResult(canonicalBody);
  }

  const metrics = emptyMetrics();
  let fidelity: ProviderStateFidelity = "exact";

  if (options.strategy === "cpa") {
    applyCpaCleanup(parsed, metrics);
  } else if (options.strategy === "cross_domain") {
    fidelity = applyCrossDomainCleanup(parsed, metrics, options.targetStateDomain);
  } else {
    fidelity = options.priorStrategy === "cross_domain"
      ? applyCrossDomainCleanup(parsed, metrics, options.targetStateDomain)
      : (applyCpaCleanup(parsed, metrics), "exact");
    applyErrorRecovery(parsed, metrics, options.errorCode);
  }

  const changed = hasChanges(metrics) || hasPromptCacheKeyRewrite(canonicalBody, parsed);
  if (!changed) {
    return unchangedResult(canonicalBody, metrics, fidelity);
  }

  const body = Buffer.from(JSON.stringify(parsed));
  return {
    body,
    bodyHash: hashProviderStateBody(body),
    changed: true,
    fidelity,
    metrics
  };
}

export function providerStateErrorCode(
  status: number,
  responseBody: Buffer
): ProviderStateErrorCode | null {
  if (status !== 400) {
    return null;
  }

  const parsed = parseJsonRecord(responseBody);
  const error = isRecord(parsed?.error) ? parsed.error : null;
  const candidates = [error?.code, parsed?.code, error?.type, parsed?.type];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }

    const normalized = candidate.trim().toLowerCase();
    if (normalized === "invalid_encrypted_content") {
      return normalized;
    }
    if (
      normalized === "previous_response_not_found" ||
      normalized === "invalid_previous_response_id"
    ) {
      return "previous_response_not_found";
    }
  }

  return null;
}

export function hashProviderStateBody(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
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
      } else {
        metrics.compactionItemsRemoved += 1;
        fidelity = "degraded";
      }
      continue;
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
  errorCode: ProviderStateErrorCode | undefined
): void {
  if (errorCode === "invalid_encrypted_content") {
    if (!Array.isArray(body.input)) {
      return;
    }

    for (const item of body.input) {
      if (!isRecord(item) || item.type !== "reasoning") {
        continue;
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
    }
  } else if (errorCode === "previous_response_not_found") {
    removePreviousResponseIds(body, metrics);
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
  if (Array.isArray(value)) {
    for (const item of value) {
      stripPrivateMetadata(item, metrics);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (key === "_passthrough" || key.startsWith("internal_")) {
      delete value[key];
      metrics.privateMetadataFieldsRemoved += 1;
      continue;
    }
    stripPrivateMetadata(value[key], metrics);
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
    changed: false,
    fidelity,
    metrics
  };
}
