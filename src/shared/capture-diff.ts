import type { CapturePayload, CaptureRecord, CaptureResponsePayload } from "./types.js";
import { isRecord } from "./records.js";

export type CaptureDiffKind = "added" | "removed" | "changed";

export interface CaptureDiffEntry {
  path: string;
  kind: CaptureDiffKind;
  before: string | null;
  after: string | null;
}

export interface CaptureDiffResult {
  available: boolean;
  equivalent: boolean;
  reason: "transparent" | "unavailable" | "invalid_json" | "truncated" | "diff_limit" | "depth_limit" | null;
  entries: CaptureDiffEntry[];
  truncated: boolean;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_VALUE_CHARS = 240;
const MAX_DEPTH = 32;

export function captureRequestDiff(
  capture: CaptureRecord,
  maxEntries = DEFAULT_MAX_ENTRIES
): CaptureDiffResult {
  return diffPayload(capture.incoming_request, capture.upstream_request, maxEntries);
}

export function captureResponseDiff(
  capture: CaptureRecord,
  maxEntries = DEFAULT_MAX_ENTRIES
): CaptureDiffResult {
  if (capture.client_response === null) {
    if (capture.stream_outcome !== "success") return unavailable("unavailable");
    return {
      available: true,
      equivalent: true,
      reason: "transparent",
      entries: [],
      truncated: false
    };
  }
  return diffPayload(capture.upstream_response, capture.client_response, maxEntries);
}

export function diffCapturePayloads(
  before: CapturePayload | CaptureResponsePayload,
  after: CapturePayload | CaptureResponsePayload,
  maxEntries = DEFAULT_MAX_ENTRIES
): CaptureDiffResult {
  return diffPayload(before, after, maxEntries);
}

function diffPayload(
  before: CapturePayload | CaptureResponsePayload,
  after: CapturePayload | CaptureResponsePayload,
  maxEntries: number
): CaptureDiffResult {
  if (before.body.truncated || after.body.truncated) {
    return unavailable("truncated");
  }

  const beforeValue = parsePayload(before);
  const afterValue = before.body.text === after.body.text ? beforeValue : parsePayload(after);
  if (beforeValue === undefined || afterValue === undefined) {
    return unavailable("invalid_json");
  }

  const result: CaptureDiffResult = { available: true, equivalent: true, reason: null, entries: [], truncated: false };
  walkDiff(beforeValue, afterValue, "$", result, maxEntries, 0);
  return result;
}

function parsePayload(payload: CapturePayload | CaptureResponsePayload): unknown {
  try {
    // Absent only on a capture read straight off disk; the API decodes it first.
    return JSON.parse(payload.body.text ?? "") as unknown;
  } catch {
    return undefined;
  }
}

function walkDiff(
  before: unknown,
  after: unknown,
  path: string,
  result: CaptureDiffResult,
  maxEntries: number,
  depth: number
): void {
  if (Object.is(before, after)) return;
  if (isContainer(before) && isContainer(after) && Array.isArray(before) === Array.isArray(after)) {
    if (depth === MAX_DEPTH) {
      const equal = compareImmediateChildren(before, after);
      if (equal === true) return;
      if (equal === undefined) {
        result.reason = "depth_limit";
        result.truncated = true;
        result.equivalent = false;
        return;
      }
    } else if (Array.isArray(before) && Array.isArray(after)) {
      for (let i = 0; i < Math.max(before.length, after.length); i++) {
        walkDiff(before[i], after[i], `${path}[${i}]`, result, maxEntries, depth + 1);
        if (result.reason === "diff_limit") break;
      }
      return;
    } else {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      for (const key of keys) {
        walkDiff(child(before, key), child(after, key), `${path}.${key}`, result, maxEntries, depth + 1);
        if (result.reason === "diff_limit") break;
      }
      return;
    }
  }

  result.equivalent = false;
  if (result.entries.length >= maxEntries) {
    result.reason = "diff_limit";
    result.truncated = true;
    return;
  }
  result.entries.push({
    path,
    kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    before: before === undefined ? null : preview(before),
    after: after === undefined ? null : preview(after)
  });
}

function child(container: Record<string, unknown> | unknown[], key: string): unknown {
  if (!Object.hasOwn(container, key)) return undefined;
  return Array.isArray(container) ? container[Number(key)] : container[key];
}

/** At the path limit a differing key or scalar still proves the whole subtree changed. */
function compareImmediateChildren(
  before: Record<string, unknown> | unknown[], after: Record<string, unknown> | unknown[]
): boolean | undefined {
  const keys = Object.keys(before);
  if (keys.length !== Object.keys(after).length) return false;
  let unresolved = false;
  for (const key of keys) {
    const a = child(before, key);
    const b = child(after, key);
    if (Object.is(a, b)) continue;
    if (!isContainer(a) || !isContainer(b) || Array.isArray(a) !== Array.isArray(b)) return false;
    unresolved = true;
  }
  return unresolved ? undefined : true;
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function preview(value: unknown): string {
  let text = "";
  function write(item: unknown): void {
    if (text.length > DEFAULT_MAX_VALUE_CHARS) return;
    // Each opening delimiter consumes a character, so even extremely deep JSON is bounded.
    if (Array.isArray(item)) {
      text += "[";
      for (let i = 0; i < item.length && text.length <= DEFAULT_MAX_VALUE_CHARS; i++) {
        if (i) text += ",";
        write(item[i]);
      }
      text += "]";
    } else if (isRecord(item)) {
      text += "{";
      let first = true;
      for (const key in item) {
        if (text.length > DEFAULT_MAX_VALUE_CHARS) break;
        if (!Object.hasOwn(item, key)) continue;
        if (!first) text += ",";
        first = false;
        write(key);
        text += ":";
        write(item[key]);
      }
      text += "}";
    } else {
      text += JSON.stringify(typeof item === "string" ? item.slice(0, DEFAULT_MAX_VALUE_CHARS + 1) : item);
    }
  }
  write(value);
  return text.length > DEFAULT_MAX_VALUE_CHARS
    ? `${text.slice(0, DEFAULT_MAX_VALUE_CHARS)}...`
    : text;
}

function unavailable(reason: "unavailable" | "invalid_json" | "truncated"): CaptureDiffResult {
  return {
    available: false,
    equivalent: false,
    reason,
    entries: [],
    truncated: false
  };
}
