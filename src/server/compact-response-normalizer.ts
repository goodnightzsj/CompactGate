import { sseDataFrames } from "./sse-frames.js";
import type { IncomingHttpHeaders } from "node:http";
import {
  decodeBodyText,
  isRecord,
  looksLikeGzip,
  looksLikeZstd,
  parseJsonRecord,
  readHeaderString
} from "./http-utils.js";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource
} from "../shared/types.js";
import { MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES } from "./upstream-response-buffer.js";
import { decodeEncodedBody } from "./usage-utils.js";

export interface CompactResponseNormalizationResult {
  bridgeOutput: Array<Record<string, unknown>>;
  responseItemCount: number;
  normalized: boolean;
  reason: CompactResponseNormalizeReason | null;
  syntheticSource: CompactResponseSyntheticSource | null;
}

export interface CompactResponseNormalizationOptions {
  status: number;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  requestBody: Buffer;
}

const MAX_SYNTHETIC_SUMMARY_CHARS = 200_000;

interface RawCompactResponseExtraction {
  outputItems: Array<Record<string, unknown>>;
  summaryText: string | null;
}

export function normalizeCompactResponse({
  status,
  responseBody,
  responseHeaders,
  requestBody
}: CompactResponseNormalizationOptions): CompactResponseNormalizationResult {
  const inspected = inspectCompactResponse(responseBody, responseHeaders);
  const outputItems = inspected?.outputItems ?? [];
  const responseItemCount = outputItems.filter(isCompactionItem).length;
  const unchanged = { normalized: false, reason: null,
    syntheticSource: null, bridgeOutput: outputItems, responseItemCount };
  if (status !== 200 || !inspected) return unchanged;
  const { parsed: parsedResponse, eventStream } = inspected;
  const reason = compactResponseNormalizeReason(
    parsedResponse,
    eventStream
  );
  if (!reason) return unchanged;
  const upstreamSummary = parsedResponse
    ? usableSummaryOrNull(extractSummaryFromResponse(parsedResponse))
    : inspected.summaryText;
  const requestSummary = upstreamSummary || responseItemCount > 0 ? null : usableSummaryOrNull(extractSummaryFromRequest(requestBody));
  const syntheticSource: CompactResponseSyntheticSource = upstreamSummary || responseItemCount > 0
    ? "upstream_response"
    : "request_input";
  const summaryText = upstreamSummary ?? requestSummary ?? "Compact response did not include readable context.";
  return {
    bridgeOutput: responseItemCount > 0 ? outputItems : [{
      type: "compaction", encrypted_content: truncateSyntheticSummary(summaryText)
    }],
    responseItemCount,
    normalized: true,
    reason,
    syntheticSource
  };
}

export function countCompactResponseItems(
  responseBody: Buffer,
  responseHeaders: IncomingHttpHeaders
): number {
  return inspectCompactResponse(responseBody, responseHeaders)?.outputItems.filter(isCompactionItem).length ?? 0;
}

function inspectCompactResponse(
  body: Buffer,
  headers: IncomingHttpHeaders
): (RawCompactResponseExtraction & { parsed: Record<string, unknown> | null; eventStream: boolean }) | null {
  const declared = readHeaderString(headers["content-encoding"])?.trim().toLowerCase();
  const encoding = declared || (looksLikeGzip(body) ? "gzip" : looksLikeZstd(body) ? "zstd" : "identity");
  if (body.length > MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES) return null;
  const decoded = decodeEncodedBody(body, encoding, MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES);
  if (!decoded) return null;
  const text = decoded.toString("utf8").trim();
  const eventStream = (readHeaderString(headers["content-type"]) ?? "").toLowerCase().includes("text/event-stream");
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) return {
        parsed, eventStream, outputItems: Array.isArray(parsed.output) ? parsed.output.filter(isRecord) : [],
        summaryText: null
      };
    } catch { /* Some compatible upstreams return a readable summary instead of JSON. */ }
  }
  return {
    parsed: null, eventStream, ...extractRawCompactResponse(text, eventStream)
  };
}

function compactResponseNormalizeReason(
  parsed: Record<string, unknown> | null,
  eventStream: boolean
): CompactResponseNormalizeReason | null {
  if (!parsed) {
    // Codex compact is streaming by design, and a stream is legitimately not a
    // JSON object. Calling that malformed labelled every healthy streaming
    // compact as broken in the log feed; it is the conversion case instead.
    return eventStream ? "missing_compaction_output" : "malformed_json";
  }

  return Array.isArray(parsed.output) ? null : "missing_compaction_output";
}

function extractSummaryFromResponse(response: Record<string, unknown>): string | null {
  const outputText = typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (outputText.length > 0) {
    return outputText;
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const text = output
    .flatMap((item) => extractAssistantMessageText(item))
    .join("\n\n")
    .trim();
  if (text.length > 0) {
    return text;
  }

  return extractChatChoiceText(response);
}

function extractAssistantMessageText(value: unknown): string[] {
  if (!isRecord(value) || value.type !== "message" || value.role !== "assistant") {
    return [];
  }

  return extractContentText(value.content);
}

function extractChatChoiceText(response: Record<string, unknown>): string | null {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const texts = choices.flatMap((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) {
      return [];
    }

    return extractContentText(choice.message.content);
  });
  const text = texts.join("\n\n").trim();
  return text.length > 0 ? text : null;
}

function extractOutputItemFromStreamEvent(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || value.type !== "response.output_item.done" || !isRecord(value.item)) {
    return null;
  }

  return isCompactionItem(value.item) || (value.item.type === "message" && value.item.role === "assistant")
    ? value.item
    : null;
}

function extractRawCompactResponse(text: string, eventStream: boolean): RawCompactResponseExtraction {
  if (!text) {
    return { outputItems: [], summaryText: null };
  }

  if (!eventStream) {
    return { outputItems: [], summaryText: usableSummaryOrNull(text) };
  }

  const deltas: string[] = [];
  let outputItems: Array<Record<string, unknown>> = [];
  let completedSummary: string | null = null;
  for (const payload of sseDataFrames(text)) {
    try {
      const event = JSON.parse(payload) as unknown;
      if (isRecord(event) && event.type === "response.output_text.delta" && typeof event.delta === "string") {
        deltas.push(event.delta);
      }
      const outputItem = extractOutputItemFromStreamEvent(event);
      if (outputItem) {
        outputItems.push(outputItem);
      }
      if (isRecord(event) && event.type === "response.completed" && isRecord(event.response) && Array.isArray(event.response.output)) {
        const completed = event.response.output.filter(isRecord);
        if (completed.some(isCompactionItem)) outputItems = completed;
        completedSummary = completed.flatMap(extractAssistantMessageText).join("\n\n").trim() || null;
      }
    } catch {
      continue;
    }
  }

  const itemSummary = outputItems
    .flatMap((item) => extractAssistantMessageText(item))
    .join("\n\n")
    .trim();
  const streamedText = deltas.join("").trim();
  return {
    outputItems,
    summaryText: completedSummary ?? (itemSummary || streamedText || null)
  };
}

function extractSummaryFromRequest(requestBody: Buffer): string | null {
  const parsed = parseJsonRecord(requestBody);
  if (!parsed) {
    const text = decodeBodyText(requestBody).trim();
    return text.length > 0 ? text : null;
  }

  const input = parsed.input;
  if (typeof input === "string") {
    return input.trim() || null;
  }

  if (!Array.isArray(input)) {
    return null;
  }

  const text = input
    .flatMap((item) => extractInputItemText(item))
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

function extractInputItemText(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }

  if (value.type === "message") {
    const role = typeof value.role === "string" ? value.role : "message";
    return extractContentText(value.content).map((text) => `${role}: ${text}`);
  }

  return [];
}

function extractContentText(content: unknown): string[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text.length > 0 ? [text] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part) => {
    if (!isRecord(part) || typeof part.text !== "string") {
      return [];
    }

    const text = part.text.trim();
    return text.length > 0 ? [text] : [];
  });
}

function truncateSyntheticSummary(text: string): string {
  if (text.length <= MAX_SYNTHETIC_SUMMARY_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_SYNTHETIC_SUMMARY_CHARS)}\n\n[CompactGate truncated synthetic compact summary]`;
}

function usableSummaryOrNull(text: string | null): string | null {
  const summary = text?.trim() ?? "";
  return summary.length >= 24 ? summary : null;
}

function isCompactionItem(value: unknown): value is { type: "compaction"; encrypted_content: string } {
  return (
    isRecord(value) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string"
  );
}
