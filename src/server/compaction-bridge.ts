import { gunzipSync } from "node:zlib";

export interface PrimaryBridgeResult {
  body: Buffer;
  replacedCompactionCount: number;
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
}

interface CachedFallbackItems {
  items: unknown[];
  expiresAt: number;
}

const DEFAULT_BRIDGE_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_BRIDGE_ENTRIES = 512;
const DEFAULT_MAX_DECODED_COMPACTION_BYTES = 8 * 1024 * 1024;

export class CompactionBridgeStore {
  private readonly fallbackItemsByKey = new Map<string, CachedFallbackItems>();

  private readonly pendingCompactFollowUps = new Map<string, number>();

  private readonly now: () => number;

  private readonly ttlMs: number;

  private readonly maxEntries: number;

  constructor(options: CompactionBridgeStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_BRIDGE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_BRIDGE_ENTRIES;
  }

  storeCompactResponse(
    responseBody: Buffer,
    options: { armFollowUp?: boolean; scope: CompactionBridgeScope }
  ): void {
    const armFollowUp = options.armFollowUp ?? true;
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
      if (armFollowUp) {
        rememberMapEntry(this.pendingCompactFollowUps, key, expiresAt);
      }

      const fallbackItems = extractFallbackItems(output, item);
      if (fallbackItems.length === 0) {
        continue;
      }

      rememberMapEntry(this.fallbackItemsByKey, key, {
        items: deepCloneJsonArray(fallbackItems),
        expiresAt
      });
    }

    enforceMaxEntries(this.pendingCompactFollowUps, this.maxEntries);
    enforceMaxEntries(this.fallbackItemsByKey, this.maxEntries);
  }

  consumeCompactFollowUp(rawBody: Buffer, scope: CompactionBridgeScope): boolean {
    const parsed = parseJsonRecord(rawBody);
    const input = Array.isArray(parsed?.input) ? parsed.input : null;
    const now = this.now();
    this.pruneExpired(now);

    if (!input) {
      return false;
    }

    for (const item of input) {
      if (!isCompactionItem(item)) {
        continue;
      }

      const key = compactionKey(scope, item.encrypted_content);
      const expiresAt = this.pendingCompactFollowUps.get(key);
      if (!expiresAt || expiresAt <= now) {
        this.pendingCompactFollowUps.delete(key);
        continue;
      }

      this.pendingCompactFollowUps.delete(key);
      return true;
    }

    return false;
  }

  rewritePrimaryBody(rawBody: Buffer, scope: CompactionBridgeScope): PrimaryBridgeResult {
    const parsed = parseJsonRecord(rawBody);
    const input = Array.isArray(parsed?.input) ? parsed.input : null;
    this.pruneExpired(this.now());

    if (!parsed || !input) {
      return { body: rawBody, replacedCompactionCount: 0 };
    }

    let replacedCompactionCount = 0;
    const rewrittenInput: unknown[] = [];

    for (const item of input) {
      if (!isCompactionItem(item)) {
        rewrittenInput.push(item);
        continue;
      }

      const fallback = this.fallbackItemsByKey.get(compactionKey(scope, item.encrypted_content));
      if (fallback) {
        rewrittenInput.push(...deepCloneJsonArray(fallback.items));
        replacedCompactionCount += 1;
        continue;
      }

      const synthesizedMessage = synthesizeAssistantMessage(item.encrypted_content);
      if (!synthesizedMessage) {
        rewrittenInput.push(item);
        continue;
      }

      rewrittenInput.push(synthesizedMessage);
      replacedCompactionCount += 1;
    }

    if (replacedCompactionCount === 0) {
      return { body: rawBody, replacedCompactionCount: 0 };
    }

    parsed.input = rewrittenInput;
    return {
      body: Buffer.from(JSON.stringify(parsed)),
      replacedCompactionCount
    };
  }

  private pruneExpired(now: number): void {
    for (const [key, expiresAt] of this.pendingCompactFollowUps.entries()) {
      if (expiresAt <= now) {
        this.pendingCompactFollowUps.delete(key);
      }
    }

    for (const [key, fallback] of this.fallbackItemsByKey.entries()) {
      if (fallback.expiresAt <= now) {
        this.fallbackItemsByKey.delete(key);
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

function parseJsonRecord(buffer: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    if (!looksLikeGzip(buffer)) {
      return null;
    }

    try {
      const parsed = JSON.parse(gunzipSync(buffer, {
        maxOutputLength: DEFAULT_MAX_DECODED_COMPACTION_BYTES
      }).toString("utf8")) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
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

function looksLikeGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
