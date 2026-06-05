import { gunzipSync } from "node:zlib";

export interface PrimaryBridgeResult {
  body: Buffer;
  replacedCompactionCount: number;
}

export class CompactionBridgeStore {
  private readonly fallbackItemsByEncryptedContent = new Map<string, unknown[]>();

  private readonly pendingCompactFollowUps = new Set<string>();

  storeCompactResponse(responseBody: Buffer, options: { armFollowUp?: boolean } = {}): void {
    const armFollowUp = options.armFollowUp ?? true;
    const parsed = parseJsonRecord(responseBody);
    const output = Array.isArray(parsed?.output) ? parsed.output : null;

    if (!output || output.length === 0) {
      return;
    }

    for (const item of output) {
      if (!isCompactionItem(item)) {
        continue;
      }

      if (armFollowUp) {
        this.pendingCompactFollowUps.add(item.encrypted_content);
      }

      const fallbackItems = extractFallbackItems(output, item);
      if (fallbackItems.length === 0) {
        continue;
      }

      this.fallbackItemsByEncryptedContent.set(
        item.encrypted_content,
        deepCloneJsonArray(fallbackItems)
      );
    }
  }

  consumeCompactFollowUp(rawBody: Buffer): boolean {
    const parsed = parseJsonRecord(rawBody);
    const input = Array.isArray(parsed?.input) ? parsed.input : null;

    if (!input) {
      return false;
    }

    for (const item of input) {
      if (!isCompactionItem(item) || !this.pendingCompactFollowUps.has(item.encrypted_content)) {
        continue;
      }

      this.pendingCompactFollowUps.delete(item.encrypted_content);
      return true;
    }

    return false;
  }

  rewritePrimaryBody(rawBody: Buffer): PrimaryBridgeResult {
    const parsed = parseJsonRecord(rawBody);
    const input = Array.isArray(parsed?.input) ? parsed.input : null;

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

      const fallbackItems = this.fallbackItemsByEncryptedContent.get(item.encrypted_content);
      if (fallbackItems) {
        rewrittenInput.push(...deepCloneJsonArray(fallbackItems));
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
      const parsed = JSON.parse(gunzipSync(buffer).toString("utf8")) as unknown;
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
