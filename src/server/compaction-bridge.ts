import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource
} from "../shared/types.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";

export interface PrimaryBridgeResult {
  body: Buffer;
  replacedCompactionCount: number;
  remainingCompactionCount: number;
  knownMissingCompactionCount: number;
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
}

export interface CachedCompactResponse {
  status: number;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  clientResponseBody: Buffer;
  clientResponseHeaders: IncomingHttpHeaders;
  compactResponseNormalized: boolean;
  compactResponseNormalizeReason: CompactResponseNormalizeReason | null;
  compactResponseSyntheticSource: CompactResponseSyntheticSource | null;
  firstTokenMs: number | null;
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

  private readonly knownCompactionStateByContent = new Map<string, number>();

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
      clientResponseBody: Buffer.from(entry.clientResponseBody),
      clientResponseHeaders: { ...entry.clientResponseHeaders },
      compactResponseNormalized: entry.compactResponseNormalized,
      compactResponseNormalizeReason: entry.compactResponseNormalizeReason,
      compactResponseSyntheticSource: entry.compactResponseSyntheticSource,
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
      responseHeaders: { ...response.responseHeaders },
      clientResponseBody: Buffer.from(response.clientResponseBody),
      clientResponseHeaders: { ...response.clientResponseHeaders },
      compactResponseNormalized: response.compactResponseNormalized,
      compactResponseNormalizeReason: response.compactResponseNormalizeReason,
      compactResponseSyntheticSource: response.compactResponseSyntheticSource,
      firstTokenMs: response.firstTokenMs,
      expiresAt: now + this.compactDedupeTtlMs
    });
    enforceMaxEntries(this.compactResponsesByKey, this.maxCompactDedupeEntries);
  }

  storeCompactResponse(
    responseBody: Buffer,
    options: { scope: CompactionBridgeScope; source?: CompactionBridgeFallbackSource }
  ): void {
    const parsed = parseJsonRecord(responseBody);
    const output = Array.isArray(parsed?.output) ? parsed.output : null;
    const now = this.now();
    const expiresAt = now + this.ttlMs;
    this.pruneExpired(now);

    if (!output || output.length === 0) {
      return;
    }

    for (const item of output) {
      if (!isCompactionItem(item)) {
        continue;
      }

      const key = compactionKey(options.scope, item.encrypted_content);
      const fallbackItems = extractFallbackItems(output, item);
      rememberMapEntry(this.knownCompactionStateByContent, item.encrypted_content, expiresAt);
      if (fallbackItems.length === 0) {
        continue;
      }

      rememberMapEntry(this.fallbackItemsByKey, key, {
        items: deepCloneJsonArray(fallbackItems),
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
        remainingCompactionCount: 0,
        knownMissingCompactionCount: 0
      };
    }

    let replacedCompactionCount = 0;
    let remainingCompactionCount = 0;
    let knownMissingCompactionCount = 0;
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

      if (!allowReadableFallback) {
        rewrittenInput.push(item);
        remainingCompactionCount += 1;
        knownMissingCompactionCount += this.knownCompactionStateByContent.has(item.encrypted_content) ? 1 : 0;
        continue;
      }

      const synthesizedMessage = synthesizeAssistantMessage(item.encrypted_content);
      if (!synthesizedMessage) {
        rewrittenInput.push(item);
        remainingCompactionCount += 1;
        knownMissingCompactionCount += this.knownCompactionStateByContent.has(item.encrypted_content) ? 1 : 0;
        continue;
      }

      rewrittenInput.push(synthesizedMessage);
      replacedCompactionCount += 1;
    }

    if (replacedCompactionCount === 0) {
      return {
        body: rawBody,
        replacedCompactionCount: 0,
        remainingCompactionCount,
        knownMissingCompactionCount
      };
    }

    parsed.input = rewrittenInput;
    return {
      body: Buffer.from(JSON.stringify(parsed)),
      replacedCompactionCount,
      remainingCompactionCount,
      knownMissingCompactionCount
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, fallback] of this.fallbackItemsByKey.entries()) {
      if (fallback.expiresAt <= now) {
        this.fallbackItemsByKey.delete(key);
      }
    }

    for (const [encryptedContent, expiresAt] of this.knownCompactionStateByContent.entries()) {
      if (expiresAt <= now) {
        this.knownCompactionStateByContent.delete(encryptedContent);
      }
    }

    for (const [key, response] of this.compactResponsesByKey.entries()) {
      if (response.expiresAt <= now) {
        this.compactResponsesByKey.delete(key);
      }
    }
  }
}

function rememberMapEntry<Value>(map: Map<string, Value>, key: string, value: Value): void {
  map.delete(key);
  map.set(key, value);
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

function compactionKey(scope: CompactionBridgeScope, encryptedContent: string): string {
  return JSON.stringify([
    scope.compactUpstream,
    scope.sourceModel ?? "",
    scope.targetModel ?? "",
    encryptedContent
  ]);
}

function compactDedupeKey(input: CompactResponseDedupeInput): string {
  return JSON.stringify([
    (input.method ?? "POST").toUpperCase(),
    input.upstream.toString(),
    hashText(input.authorization ?? ""),
    hashText(JSON.stringify(canonicalDedupeHeaders(input.requestHeaders ?? {}))),
    hashBuffer(input.body)
  ]);
}

function canonicalDedupeHeaders(headers: Record<string, string>): Array<[string, string]> {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
    .filter(([name]) => name !== "content-length")
    .sort(([left], [right]) => left.localeCompare(right));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractFallbackItems(
  output: unknown[],
  compactionItem: { type: "compaction"; encrypted_content: string }
): unknown[] {
  const assistantMessages = output.filter(
    (item) => isMessageItem(item) && item.role === "assistant"
  );
  if (assistantMessages.length > 0) {
    return assistantMessages;
  }

  const userMessages = output.filter((item) => isMessageItem(item) && item.role === "user");
  if (userMessages.length > 0) {
    return userMessages;
  }

  const synthesizedMessage = synthesizeAssistantMessage(compactionItem.encrypted_content);
  return synthesizedMessage ? [synthesizedMessage] : [];
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

function isMessageItem(value: unknown): value is { type: "message"; role: string } {
  return isRecord(value) && value.type === "message" && typeof value.role === "string";
}

function deepCloneJsonArray(items: unknown[]): unknown[] {
  return JSON.parse(JSON.stringify(items)) as unknown[];
}

function synthesizeAssistantMessage(encryptedContent: string): Record<string, unknown> | null {
  const text = encryptedContent.trim();
  if (!looksLikeReadableSummary(text)) {
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

function hasNaturalTextStructure(text: string): boolean {
  return /[\s`:\-.,;!?()[\]{}#*_>，。；：、（）【】《》？！]/u.test(text);
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
