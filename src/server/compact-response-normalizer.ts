import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  decodeBodyText,
  isRecord,
  parseJsonRecord
} from "./http-utils.js";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource
} from "../shared/types.js";

export interface CompactResponseNormalizationResult {
  body: Buffer;
  headers: IncomingHttpHeaders;
  normalized: boolean;
  reason: CompactResponseNormalizeReason | null;
  syntheticSource: CompactResponseSyntheticSource | null;
}

export interface CompactResponseNormalizationOptions {
  status: number;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  requestBody: Buffer;
  now?: () => number;
  idFactory?: () => string;
}

const MAX_SYNTHETIC_SUMMARY_CHARS = 200_000;

export function normalizeCompactResponse({
  status,
  responseBody,
  responseHeaders,
  requestBody,
  now = Date.now,
  idFactory = createCompactGateResponseId
}: CompactResponseNormalizationOptions): CompactResponseNormalizationResult {
  if (status !== 200) {
    return unchangedCompactResponse(responseBody, responseHeaders);
  }

  const parsedResponse = parseJsonRecord(responseBody);
  const reason = compactResponseNormalizeReason(parsedResponse);
  if (!reason) {
    return unchangedCompactResponse(responseBody, responseHeaders);
  }

  const upstreamSummary = parsedResponse
    ? usableSummaryOrNull(extractSummaryFromResponse(parsedResponse))
    : usableSummaryOrNull(extractSummaryFromRawResponse(responseBody, responseHeaders));
  const requestSummary = upstreamSummary ? null : usableSummaryOrNull(extractSummaryFromRequest(requestBody));
  const syntheticSource: CompactResponseSyntheticSource = upstreamSummary
    ? "upstream_response"
    : "request_input";
  const summaryText = upstreamSummary ?? requestSummary ?? "Compact response did not include readable context.";
  const synthetic = buildSyntheticCompactResponse({
    parsedResponse,
    summaryText: truncateSyntheticSummary(summaryText),
    now,
    idFactory
  });
  const body = Buffer.from(JSON.stringify(synthetic));

  return {
    body,
    headers: syntheticResponseHeaders(responseHeaders, body),
    normalized: true,
    reason,
    syntheticSource
  };
}

function unchangedCompactResponse(
  body: Buffer,
  headers: IncomingHttpHeaders
): CompactResponseNormalizationResult {
  return {
    body,
    headers,
    normalized: false,
    reason: null,
    syntheticSource: null
  };
}

function compactResponseNormalizeReason(
  parsed: Record<string, unknown> | null
): CompactResponseNormalizeReason | null {
  if (!parsed) {
    return "malformed_json";
  }

  if (parsed.object !== "response.compaction") {
    return "missing_response_compaction_object";
  }

  const output = Array.isArray(parsed.output) ? parsed.output : [];
  return output.some(isCompactionItem) ? null : "missing_compaction_output";
}

function buildSyntheticCompactResponse({
  parsedResponse,
  summaryText,
  now,
  idFactory
}: {
  parsedResponse: Record<string, unknown> | null;
  summaryText: string;
  now: () => number;
  idFactory: () => string;
}): Record<string, unknown> {
  const responseId = typeof parsedResponse?.id === "string" && parsedResponse.id.length > 0
    ? parsedResponse.id
    : idFactory();
  const createdAt = typeof parsedResponse?.created_at === "number"
    ? parsedResponse.created_at
    : Math.floor(now() / 1000);
  const synthetic: Record<string, unknown> = {
    id: responseId,
    object: "response.compaction",
    created_at: createdAt,
    output: [
      {
        type: "compaction",
        encrypted_content: summaryText
      }
    ]
  };

  if (isRecord(parsedResponse?.usage)) {
    synthetic.usage = parsedResponse.usage;
  }

  return synthetic;
}

function syntheticResponseHeaders(
  upstreamHeaders: IncomingHttpHeaders,
  body: Buffer
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...upstreamHeaders };
  delete headers["content-encoding"];
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  headers["content-type"] = "application/json; charset=utf-8";
  headers["content-length"] = String(body.byteLength);
  return headers;
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

function extractSummaryFromRawResponse(
  responseBody: Buffer,
  responseHeaders: IncomingHttpHeaders
): string | null {
  const contentType = headerText(responseHeaders["content-type"]).toLowerCase();
  const text = decodeBodyText(responseBody).trim();
  if (!text) {
    return null;
  }

  if (!contentType.includes("text/event-stream")) {
    return text;
  }

  const deltas: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    try {
      const event = JSON.parse(payload) as unknown;
      if (isRecord(event) && event.type === "response.output_text.delta" && typeof event.delta === "string") {
        deltas.push(event.delta);
      }
    } catch {
      continue;
    }
  }

  const streamedText = deltas.join("").trim();
  return streamedText.length > 0 ? streamedText : null;
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

function createCompactGateResponseId(): string {
  return `resp_compactgate_${randomUUID().replaceAll("-", "")}`;
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}
