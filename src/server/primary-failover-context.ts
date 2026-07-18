import type { IncomingHttpHeaders } from "node:http";
import { createHash } from "node:crypto";
import { parseJsonRecord } from "./http-utils.js";
import type { PrimaryRouteRequestContext } from "./primary-failover-types.js";

export function primaryRouteRequestContextFromBody(
  rawBody: Buffer,
  headers: IncomingHttpHeaders = {},
  endpoint: string | null = null
): PrimaryRouteRequestContext {
  const parsed = parseJsonRecord(rawBody);
  const model = readTrimmedString(parsed?.model);
  const previousResponseId =
    readTrimmedString(parsed?.previous_response_id) ??
    readTrimmedString(parsed?.previousResponseId);

  return {
    endpoint,
    model,
    previousResponseId,
    sessionKey: readSessionKey(parsed, headers),
    compactionStateKey: readCompactionStateKey(parsed)
  };
}

export function normalizeRequestContext(
  context: PrimaryRouteRequestContext
): Required<PrimaryRouteRequestContext> {
  return {
    endpoint: context.endpoint ?? null,
    model: context.model ?? null,
    previousResponseId: context.previousResponseId ?? null,
    sessionKey: context.sessionKey ?? null,
    compactionStateKey: context.compactionStateKey ?? null
  };
}

function readSessionKey(
  parsed: Record<string, unknown> | null,
  headers: IncomingHttpHeaders
): string | null {
  const metadata = isRecord(parsed?.metadata) ? parsed.metadata : null;
  const clientMetadata = isRecord(parsed?.client_metadata) ? parsed.client_metadata : null;
  return (
    readTrimmedString(parsed?.session_hash) ??
    readTrimmedString(parsed?.session_id) ??
    readTrimmedString(parsed?.conversation_id) ??
    readTrimmedString(clientMetadata?.thread_id) ??
    readTrimmedString(clientMetadata?.session_id) ??
    readTrimmedString(metadata?.session_hash) ??
    readTrimmedString(metadata?.session_id) ??
    readHeader(headers["x-compactgate-session"]) ??
    readHeader(headers["thread-id"]) ??
    readHeader(headers["session-id"]) ??
    readHeader(headers["x-session-id"]) ??
    readHeader(headers["x-conversation-id"]) ??
    readHeader(headers["openai-conversation-id"])
  );
}

function readCompactionStateKey(parsed: Record<string, unknown> | null): string | null {
  const input = Array.isArray(parsed?.input) ? parsed.input : null;
  if (!input) {
    return null;
  }

  const encryptedContents = input.flatMap((item) => {
    if (!isRecord(item) || item.type !== "compaction" || typeof item.encrypted_content !== "string") {
      return [];
    }

    const encryptedContent = item.encrypted_content.trim();
    return encryptedContent.length > 0 ? [encryptedContent] : [];
  });

  if (encryptedContents.length === 0) {
    return null;
  }

  return `sha256:${createHash("sha256").update(JSON.stringify(encryptedContents)).digest("hex")}`;
}

function readHeader(value: IncomingHttpHeaders[string]): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return readTrimmedString(raw);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
