import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { isRecord } from "../shared/records.js";
import { decodeResponseText } from "./usage-utils.js";

export type ProviderStateErrorCode =
  | "invalid_encrypted_content"
  | "invalid_responses_request"
  | "previous_response_not_found";

export interface ProviderStateFailure {
  kind: "encrypted_content" | "resource_mismatch" | "compaction" | "continuation";
  code: ProviderStateErrorCode | null;
  evidence: "code" | "message";
  itemId: string | null;
  inputIndex: number | null;
  contentIndex?: number;
  encryptedContentHash: string | null;
  inputItemHash?: string;
}

const MAX_ERROR_MESSAGE_LENGTH = 65_536;
const MAX_DIAGNOSTIC_WRAPPERS = 8;
const DIAGNOSTIC_PREFIX = String.raw`(?:[\w.-]+ ){0,3}(?:responses|upstream|gateway|proxy|api|http 400) (?:bad request|error) *: *`;
const DIAGNOSTIC_LABEL = String.raw`(?:\[([A-Za-z][\w.-]{0,63})(?: *[:=] *([A-Za-z0-9_./:+-]{1,128}))?\]|\(([A-Za-z][\w.-]{0,63}(?: [A-Za-z][\w.-]{0,63})?) *[:=] *([\w-]{1,128})\))`;
const LEADING_DIAGNOSTIC_PREFIX = new RegExp("^" + DIAGNOSTIC_PREFIX, "i");
const LEADING_DIAGNOSTIC_LABEL = new RegExp("^" + DIAGNOSTIC_LABEL + " +", "i");
const TRAILING_DIAGNOSTIC_LABEL = new RegExp(" +" + DIAGNOSTIC_LABEL + "$", "i");
const ENCRYPTED_FAILURE_PREDICATE = String.raw`(?:could not be|cannot be|can not be|couldn't be|can't be|was not) (?:verified|decrypted(?: or parsed)?|parsed)`;
const ENCRYPTED_FAILURE = new RegExp([
  "^",
  String.raw`(?:the )?encrypted content(?: for item ([\w.-]{1,256})| ([A-Za-z0-9_+/.=-]{1,65536}))? `,
  ENCRYPTED_FAILURE_PREDICATE, String.raw`[.!]?`,
  String.raw`(?: (?:reason|cause): (?:the )?encrypted content `,
  ENCRYPTED_FAILURE_PREDICATE, String.raw`[.!]?)?$`
].join(""), "i");

// Keep the two affirmative sentences together; a resource word elsewhere is not evidence.
const RESOURCE_MISMATCH_MESSAGE = new RegExp([
  "^", "(?:" + DIAGNOSTIC_PREFIX + ")?",
  String.raw`the requested item was created under a different (?:[\w*\[\]-]{1,64} ){0,6}openai resource ?\. `,
  String.raw`use the same resource that created the item to access it ?\.`
].join(""), "i");
const GO_NUMERIC_CODE_ERROR = new RegExp([
  String.raw`^\s*failed\s+to\s+decode\s+error\s+response:\s*json:\s*cannot\s+unmarshal\s+number\s+into\s+Go\s+struct\s+field\s+`,
  String.raw`[\w.*]+\.code\s+of\s+type\s+string,\s*raw:\s*([\s\S]+)$`
].join(""), "i");

export function classifyProviderStateFailure(
  status: number,
  responseBody: Buffer,
  responseHeaders: IncomingHttpHeaders = {}
): ProviderStateFailure | null {
  if (status !== 400) return null;
  const text = decodeResponseText(responseBody, responseHeaders);
  const parsed = text === null ? null : jsonRecord(text);
  if (!parsed) return null;
  let error = isRecord(parsed.error) ? parsed.error : parsed;
  const raw = typeof error.message === "string" && error.type === "invalid_request_error"
    ? error.message.match(GO_NUMERIC_CODE_ERROR)?.[1] : null;
  if (raw) {
    const inner = jsonRecord(raw.trimEnd().replace(/\[trace_id=[a-f0-9]{32}\]$/i, ""));
    if (!isRecord(inner?.error)) return null;
    error = inner.error;
  }

  const block = typeof error.param === "string" ? error.param.match(/^input\[\d{1,6}\]\.content\[(\d{1,6})\]\.encrypted_content$/) : null;
  const base = { itemId: null, inputIndex: inputIndex(error.param), encryptedContentHash: null,
    ...(block ? { contentIndex: Number(block[1]) } : {}) };
  const codes = [error.code, parsed.code, error.type, parsed.type]
    .filter((value): value is string => typeof value === "string")
    .map(value => value.trim().toLowerCase());
  if (isRecord(parsed.error) && typeof error.code === "string" && error.code.trim().toLowerCase() === "invalid_responses_request") {
    return { ...base, kind: "compaction", code: "invalid_responses_request", evidence: "code" };
  }
  for (const code of codes) {
    if (code === "invalid_encrypted_content") {
      return { ...base, ...messageTarget(error.message), kind: "encrypted_content", code, evidence: "code" };
    }
    if (code === "previous_response_not_found" || code === "invalid_previous_response_id") {
      return { ...base, kind: "continuation", code: "previous_response_not_found", evidence: "code" };
    }
  }
  if (codes.some(code => /auth|api_key|quota|rate_limit|model_not_found|unsupported_model/.test(code))) return null;
  if (error.type !== "invalid_request_error" || typeof error.message !== "string" || error.message.length > MAX_ERROR_MESSAGE_LENGTH) return null;
  const message = error.message.trim().replace(/\s+/g, " ");
  if (RESOURCE_MISMATCH_MESSAGE.test(message)) {
    return { ...base, kind: "resource_mismatch", code: null, evidence: "message" };
  }
  const target = messageTarget(message);
  return target ? { ...base, ...target, kind: "encrypted_content", code: "invalid_encrypted_content", evidence: "message" } : null;
}

function messageTarget(value: unknown): Pick<ProviderStateFailure, "itemId" | "encryptedContentHash"> | null {
  if (typeof value !== "string" || value.length > MAX_ERROR_MESSAGE_LENGTH) return null;
  let message = value.trim().replace(/\s+/g, " ");
  const diagnosticKeys = new Set<string>();
  // Strip only bounded edge diagnostics; prose and quoted failures must still match the entire semantic core.
  for (let count = 0; ; count += 1) {
    const prefix = message.match(LEADING_DIAGNOSTIC_PREFIX);
    const label = prefix ? null : message.match(LEADING_DIAGNOSTIC_LABEL) ?? message.match(TRAILING_DIAGNOSTIC_LABEL);
    const wrapper = prefix ?? label;
    if (!wrapper) break;
    if (count === MAX_DIAGNOSTIC_WRAPPERS) return null;
    if (label) {
      const key = (label[1] ?? label[3]).toLowerCase().replace(/[_. -]/g, "");
      if (diagnosticKeys.has(key)) return null;
      diagnosticKeys.add(key);
    }
    message = wrapper.index === 0 ? message.slice(wrapper[0].length) : message.slice(0, wrapper.index);
  }
  const match = message.match(ENCRYPTED_FAILURE);
  if (!match) return null;
  const content = match[2];
  return {
    itemId: match[1] ?? null,
    encryptedContentHash: content && !content.includes(".")
      ? createHash("sha256").update(content).digest("hex") : null
  };
}

function inputIndex(value: unknown): number | null {
  const match = typeof value === "string" ? value.match(/^input\[(\d{1,6})\](?:\.|$)/) : null;
  return match ? Number(match[1]) : null;
}

function jsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
