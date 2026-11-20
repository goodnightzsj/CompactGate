import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource
} from "../shared/types.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";
import { enforceMaxEntries, rememberMapEntry } from "./primary-failover-limits.js";
import { decodeCompactGateCompactionSummary } from "./protocol-conversion.js";

export interface PrimaryBridgeResult {
  body: Buffer;
  replacedCompactionCount: number;
  remainingCompactionCount: number;
}

export interface CompactionBridgeScope {
  compactUpstream: string;
  sourceModel: string | null;
  targetModel: string | null;
}

export interface CompactionBridgeStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  compactDedupeTtlMs?: number;
  maxCompactDedupeEntries?: number;
}

export type CompactionBridgeFallbackSource = "standard" | "synthetic";

interface CachedFallbackItems {
  items: unknown[];
  expiresAt: number;
  source: CompactionBridgeFallbackSource;
}

export interface CompactResponseDedupeInput {
  upstream: URL;
  authorization: string | null;
  body: Buffer;
  method?: string;
  requestHeaders?: Record<string, string>;
  proxyUrl?: string;
}

export interface CachedCompactResponse {
  status: number;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  compactResponseNormalized: boolean;
  compactResponseNormalizeReason: CompactResponseNormalizeReason | null;
  compactResponseSyntheticSource: CompactResponseSyntheticSource | null;
  firstTokenMs: number | null;
  compactResponseItemCount?: number;
}

interface CachedCompactResponseEntry extends CachedCompactResponse {
  expiresAt: number;
}

export interface PrimaryBridgeRewriteOptions {
  includeStandardFallbacks?: boolean;
  includeSyntheticFallbacks?: boolean;
  allowReadableFallback?: boolean;
}

export class UnresolvedCompactionStateError extends Error {
  constructor(remainingCompactionCount: number) {
    super(
      remainingCompactionCount === 1
        ? "Split compact follow-up still contains opaque compaction state that CompactGate could not bridge into a primary request."
        : `Split compact follow-up still contains ${remainingCompactionCount} opaque compaction items that CompactGate could not bridge into a primary request.`
    );
    this.name = "UnresolvedCompactionStateError";
  }
}

const DEFAULT_BRIDGE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_BRIDGE_ENTRIES = 512;
const DEFAULT_COMPACT_DEDUPE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_COMPACT_DEDUPE_ENTRIES = 128;

export class CompactionBridgeStore {
  private readonly fallbackItemsByKey = new Map<string, CachedFallbackItems>();

  private readonly compactResponsesByKey = new Map<string, CachedCompactResponseEntry>();

  private readonly now: () => number;

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  private readonly compactDedupeTtlMs: number;

  private readonly maxCompactDedupeEntries: number;

  constructor(options: CompactionBridgeStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_BRIDGE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_BRIDGE_ENTRIES;
    this.compactDedupeTtlMs = options.compactDedupeTtlMs ?? DEFAULT_COMPACT_DEDUPE_TTL_MS;
    this.maxCompactDedupeEntries = options.maxCompactDedupeEntries ?? DEFAULT_MAX_COMPACT_DEDUPE_ENTRIES;
  }

  getCachedCompactResponse(input: CompactResponseDedupeInput): CachedCompactResponse | null {
    const now = this.now();
    this.pruneExpired(now);
    const entry = this.compactResponsesByKey.get(compactDedupeKey(input));
    if (!entry) {
      return null;
    }

    return {
      status: entry.status,
      responseBody: Buffer.from(entry.responseBody),
      responseHeaders: { ...entry.responseHeaders },
      compactResponseNormalized: entry.compactResponseNormalized,
      compactResponseNormalizeReason: entry.compactResponseNormalizeReason,
      compactResponseSyntheticSource: entry.compactResponseSyntheticSource,
      compactResponseItemCount: entry.compactResponseItemCount,
      firstTokenMs: entry.firstTokenMs
    };
  }

  storeCompactDedupeResponse(input: CompactResponseDedupeInput, response: CachedCompactResponse): void {
    if (this.compactDedupeTtlMs <= 0 || response.status < 200 || response.status >= 300) {
      return;
    }

    const now = this.now();
    this.pruneExpired(now);
    rememberMapEntry(this.compactResponsesByKey, compactDedupeKey(input), {
      status: response.status,
      responseBody: Buffer.from(response.responseBody),
      responseHeaders: withoutSessionHeaders(response.responseHeaders),
      compactResponseNormalized: response.compactResponseNormalized,
      compactResponseNormalizeReason: response.compactResponseNormalizeReason,
      compactResponseSyntheticSource: response.compactResponseSyntheticSource,
      compactResponseItemCount: response.compactResponseItemCount,
      firstTokenMs: response.firstTokenMs,
      expiresAt: now + this.compactDedupeTtlMs
    });
    enforceMaxEntries(this.compactResponsesByKey, this.maxCompactDedupeEntries);
  }

  storeCompactResponse(
    response: Buffer | unknown[],
    options: { scope: CompactionBridgeScope; source?: CompactionBridgeFallbackSource }
  ): void {
    const output = Array.isArray(response) ? response : parseJsonRecord(response)?.output;
    const now = this.now();
    const expiresAt = now + this.ttlMs;
    this.pruneExpired(now);

    if (!Array.isArray(output) || output.length === 0) {
      return;
    }

    for (const item of output) {
      if (!isCompactionItem(item)) {
        continue;
      }

      // Retained output messages are not proof of what the opaque compaction summarized.
      const summary = synthesizeAssistantMessage(item.encrypted_content);
      if (!summary) {
        continue;
      }

      rememberMapEntry(this.fallbackItemsByKey, compactionKey(options.scope, item.encrypted_content), {
        items: [summary],
        expiresAt,
        source: options.source ?? "standard"
      });
    }

    enforceMaxEntries(this.fallbackItemsByKey, this.maxEntries);
  }

  rewritePrimaryBody(
    rawBody: Buffer,
    scope: CompactionBridgeScope,
    options: PrimaryBridgeRewriteOptions = {}
  ): PrimaryBridgeResult {
    const parsed = parseJsonRecord(rawBody);
    const input = Array.isArray(parsed?.input) ? parsed.input : null;
    this.pruneExpired(this.now());
    const includeStandardFallbacks = options.includeStandardFallbacks ?? true;
    const includeSyntheticFallbacks = options.includeSyntheticFallbacks ?? true;
    const allowReadableFallback = options.allowReadableFallback ?? true;

    if (!parsed || !input) {
      return {
        body: rawBody,
        replacedCompactionCount: 0,
        remainingCompactionCount: 0
      };
    }

    let replacedCompactionCount = 0;
    let remainingCompactionCount = 0;
    const rewrittenInput: unknown[] = [];

    for (const item of input) {
      if (!isCompactionItem(item)) {
        rewrittenInput.push(item);
        continue;
      }

      const fallback = this.fallbackItemsByKey.get(compactionKey(scope, item.encrypted_content));
      if (
        fallback &&
        ((fallback.source === "standard" && includeStandardFallbacks) ||
          (fallback.source === "synthetic" && includeSyntheticFallbacks))
      ) {
        rewrittenInput.push(...deepCloneJsonArray(fallback.items));
        replacedCompactionCount += 1;
        continue;
      }

      const synthesizedMessage = synthesizeAssistantMessage(
        item.encrypted_content,
        allowReadableFallback
      );
      if (!synthesizedMessage) {
        rewrittenInput.push(item);
        remainingCompactionCount += 1;
        continue;
      }

      rewrittenInput.push(synthesizedMessage);
      replacedCompactionCount += 1;
    }

    if (replacedCompactionCount === 0) {
      return {
        body: rawBody,
        replacedCompactionCount: 0,
        remainingCompactionCount
      };
    }

    parsed.input = rewrittenInput;
    return {
      body: Buffer.from(JSON.stringify(parsed)),
      replacedCompactionCount,
      remainingCompactionCount
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, fallback] of this.fallbackItemsByKey.entries()) {
      if (fallback.expiresAt <= now) {
        this.fallbackItemsByKey.delete(key);
      }
    }

    for (const [key, response] of this.compactResponsesByKey.entries()) {
      if (response.expiresAt <= now) {
        this.compactResponsesByKey.delete(key);
      }
    }
  }
}

function compactionKey(scope: CompactionBridgeScope, encryptedContent: string): string {
  return JSON.stringify([
    scope.compactUpstream,
    scope.sourceModel ?? "",
    scope.targetModel ?? "",
    sha256(encryptedContent)
  ]);
}

/**
 * The dedupe cache is shared across sessions by construction, so a replay must
 * not hand a later request the identity the upstream minted for an earlier one.
 */
function withoutSessionHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const { "set-cookie": _setCookie, ...rest } = headers;
  return rest;
}

function compactDedupeKey(input: CompactResponseDedupeInput): string {
  return JSON.stringify([
    (input.method ?? "POST").toUpperCase(),
    input.upstream.toString(),
    sha256(input.authorization ?? ""),
    sha256(JSON.stringify(canonicalDedupeHeaders(input.requestHeaders ?? {}))),
    sha256(input.proxyUrl ?? ""),
    sha256(input.body)
  ]);
}

function canonicalDedupeHeaders(headers: Record<string, string>): Array<[string, string]> {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
    .filter(([name]) => name !== "content-length")
    .sort(([left], [right]) => left.localeCompare(right));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isCompactionItem(
  value: unknown
): value is { type: "compaction"; encrypted_content: string } {
  return (
    isRecord(value) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string"
  );
}

function deepCloneJsonArray(items: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(items)) as unknown[];
}

export function synthesizeAssistantMessage(
  encryptedContent: string,
  allowReadableFallback = true
): Record<string, unknown> | null {
  const portableSummary = decodeCompactGateCompactionSummary(encryptedContent);
  const text = (portableSummary ?? encryptedContent).trim();
  if (!portableSummary && (!allowReadableFallback || !looksLikeReadableSummary(text))) {
    return null;
  }

  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }]
  };
}

function looksLikeReadableSummary(text: string): boolean {
  if (text.length < 24) {
    return false;
  }

  if (looksLikeEncodedBlob(text) || !hasReadableTextContent(text) || !hasNaturalTextStructure(text)) {
    return false;
  }

  const characters = Array.from(text);
  const readableCount = characters.filter((character) => isReadableSummaryCharacter(character)).length;
  return readableCount / characters.length >= 0.98;
}

function hasReadableTextContent(text: string): boolean {
  return Array.from(text).filter((character) => /[\p{L}\p{N}]/u.test(character)).length >= 8;
}

// `-` and `_` are deliberately absent: they are the two non-alphanumeric members
// of the base64url alphabet, so counting them as "structure" let an opaque state
// blob pass for prose. `looksLikeEncodedBlob` only rejects blobs of 80 characters
// or more, which left 24-79 character states — the band no check covered — being
// trimmed and replayed to the model as the conversation's recovered memory.
function hasNaturalTextStructure(text: string): boolean {
  return /[\s`:.,;!?()[\]{}#*>，。；：、（）【】《》？！]/u.test(text);
}

function looksLikeEncodedBlob(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 80) {
    return false;
  }

  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    return false;
  }

  return !/[`:,.;!?()[\]{}#*，。；：、（）【】《》？！]/u.test(text);
}

function isReadableSummaryCharacter(character: string): boolean {
  return /^[\n\r\t ]$/.test(character) || !/\p{C}/u.test(character);
}
