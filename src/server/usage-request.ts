import {
  isRecord,
  parseJsonRecord,
  readNumber,
  readTrimmedString
} from "./usage-utils.js";
import type { RequestMetadata } from "./usage-types.js";

export function extractRequestMetadata(pathname: string, rawBody: Buffer): RequestMetadata {
  const endpoint = normalizeEndpoint(pathname);
  const parsed = parseJsonRecord(rawBody);

  return {
    endpoint,
    requestType: parsed?.stream === true ? "stream" : "http",
    reasoningEffort: extractReasoningEffort(parsed),
    requestSummary: extractRequestSummary(endpoint, parsed)
  };
}

export function extractSourceModel(rawBody: Buffer): string | null {
  const parsed = parseJsonRecord(rawBody);
  return typeof parsed?.model === "string" && parsed.model.trim().length > 0
    ? parsed.model
    : null;
}

function normalizeEndpoint(pathname: string): string {
  if (pathname === "/v1") {
    return "/";
  }

  if (pathname.startsWith("/v1/")) {
    return pathname.slice(3);
  }

  return pathname || "/";
}

function extractReasoningEffort(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) {
    return null;
  }

  if (typeof parsed.reasoning_effort === "string" && parsed.reasoning_effort.trim().length > 0) {
    return parsed.reasoning_effort;
  }

  if (
    isRecord(parsed.reasoning) &&
    typeof parsed.reasoning.effort === "string" &&
    parsed.reasoning.effort.trim().length > 0
  ) {
    return parsed.reasoning.effort;
  }

  const outputConfigEffort = readOutputConfigEffort(parsed);
  if (outputConfigEffort) {
    return outputConfigEffort;
  }

  if (isRecord(parsed.thinking)) {
    const visibleEffort = readThinkingEffort(parsed.thinking);
    if (visibleEffort) {
      return visibleEffort;
    }

    const type = readTrimmedString(parsed.thinking.type) ?? "";
    const budget = typeof parsed.thinking.budget_tokens === "number" ? parsed.thinking.budget_tokens : null;
    const display = readTrimmedString(parsed.thinking.display);
    const parts = [type ? `thinking ${type}` : "thinking yes"];

    if (budget !== null) {
      parts.push(`${budget}`);
    }

    if (display) {
      parts.push(display);
    }

    return parts.join(" ");
  }

  return null;
}

function extractRequestSummary(endpoint: string, parsed: Record<string, unknown> | null): string | null {
  if (!parsed) {
    return null;
  }

  if (endpoint === "/messages" || endpoint.endsWith("/messages")) {
    return joinSummaryParts([
      countArray("messages", parsed.messages),
      describeSystem(parsed.system),
      countArray("tools", parsed.tools),
      describeNumber("max", parsed.max_tokens),
      describeThinking(parsed.thinking, parsed)
    ]);
  }

  if (endpoint === "/responses" || endpoint === "/responses/compact") {
    return joinSummaryParts([
      describeInput(parsed.input),
      countCompactionItems(parsed.input),
      countCompactionTriggers(parsed.input),
      describePresence("instructions", parsed.instructions),
      countArray("tools", parsed.tools),
      describeNumber("max", parsed.max_output_tokens),
      describePresence("previous", parsed.previous_response_id)
    ]);
  }

  if (endpoint === "/chat/completions") {
    return joinSummaryParts([
      countArray("messages", parsed.messages),
      countArray("tools", parsed.tools),
      describeNumber("max", parsed.max_tokens)
    ]);
  }

  return joinSummaryParts([
    countArray("messages", parsed.messages),
    describeInput(parsed.input),
    countArray("tools", parsed.tools)
  ]);
}

function joinSummaryParts(parts: Array<string | null>): string | null {
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(" · ") : null;
}

function countArray(label: string, value: unknown): string | null {
  return Array.isArray(value) ? `${label} ${value.length}` : null;
}

function describeSystem(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return "system yes";
  }

  if (Array.isArray(value)) {
    return `system ${value.length}`;
  }

  return null;
}

function describeInput(value: unknown): string | null {
  if (Array.isArray(value)) {
    return `input ${value.length}`;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return "input text";
  }

  if (isRecord(value)) {
    return "input object";
  }

  return null;
}

function countCompactionItems(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const count = value.filter((item) => isRecord(item) && item.type === "compaction").length;
  return count > 0 ? `compactions ${count}` : null;
}

function countCompactionTriggers(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const count = value.filter((item) => isRecord(item) && item.type === "compaction_trigger").length;
  return count > 0 ? `compaction_triggers ${count}` : null;
}

function describePresence(label: string, value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim().length > 0 ? `${label} yes` : null;
  }

  return value === undefined || value === null ? null : `${label} yes`;
}

function describeNumber(label: string, value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? `${label} ${value}` : null;
}

function describeThinking(value: unknown, parsed?: Record<string, unknown>): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const effort = readThinkingEffort(value);
  const outputConfigEffort = parsed ? readOutputConfigEffort(parsed) : null;
  const type = readTrimmedString(value.type);
  const budget = readNumber(value.budget_tokens);
  const display = readTrimmedString(value.display);
  return joinSummaryParts([
    effort ? `thinking ${effort}` : type ? `thinking ${type}` : "thinking yes",
    outputConfigEffort ? `effort ${outputConfigEffort}` : null,
    budget !== null ? `budget ${budget}` : null,
    display ? `display ${display}` : null
  ]);
}

function readOutputConfigEffort(parsed: Record<string, unknown>): string | null {
  if (!isRecord(parsed.output_config)) {
    return null;
  }

  return readKnownThinkingLevel(parsed.output_config.effort);
}

function readThinkingEffort(value: Record<string, unknown>): string | null {
  return readKnownThinkingLevel(value.effort) ??
    readKnownThinkingLevel(value.level) ??
    readKnownThinkingLevel(value.mode);
}

function readKnownThinkingLevel(value: unknown): string | null {
  const text = readTrimmedString(value)?.toLowerCase();
  if (
    text === "low" ||
    text === "medium" ||
    text === "high" ||
    text === "xhigh" ||
    text === "max" ||
    text === "minimal"
  ) {
    return text;
  }

  return null;
}
