import type { CapturePayload, CaptureRecord, CaptureResponsePayload } from "./types.js";

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
  reason: "transparent" | "invalid_json" | "truncated" | "diff_limit" | null;
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
  const afterValue = parsePayload(after);
  if (beforeValue === null || afterValue === null) {
    return unavailable("invalid_json");
  }

  const entries: CaptureDiffEntry[] = [];
  let truncated = false;
  walkDiff(beforeValue, afterValue, "$", entries, () => {
    truncated = true;
  }, maxEntries, 0);
  return {
    available: true,
    equivalent: entries.length === 0 && !truncated,
    reason: truncated ? "diff_limit" : null,
    entries,
    truncated
  };
}

function parsePayload(payload: CapturePayload | CaptureResponsePayload): unknown | null {
  try {
    return JSON.parse(payload.body.text) as unknown;
  } catch {
    return null;
  }
}

function walkDiff(
  before: unknown,
  after: unknown,
  path: string,
  entries: CaptureDiffEntry[],
  markTruncated: () => void,
  maxEntries: number,
  depth: number
): void {
  if (entries.length >= maxEntries) {
    markTruncated();
    return;
  }
  if (Object.is(before, after)) {
    return;
  }
  if (depth >= MAX_DEPTH || !isContainer(before) || !isContainer(after)) {
    entries.push({ path, kind: "changed", before: preview(before), after: preview(after) });
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= before.length) {
        addEntry(entries, markTruncated, maxEntries, {
          path: childPath,
          kind: "added",
          before: null,
          after: preview(after[index])
        });
      } else if (index >= after.length) {
        addEntry(entries, markTruncated, maxEntries, {
          path: childPath,
          kind: "removed",
          before: preview(before[index]),
          after: null
        });
      } else {
        walkDiff(before[index], after[index], childPath, entries, markTruncated, maxEntries, depth + 1);
      }
    }
    return;
  }

  if (!Array.isArray(before) && !Array.isArray(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      if (!Object.hasOwn(before, key)) {
        addEntry(entries, markTruncated, maxEntries, {
          path: childPath,
          kind: "added",
          before: null,
          after: preview(after[key])
        });
      } else if (!Object.hasOwn(after, key)) {
        addEntry(entries, markTruncated, maxEntries, {
          path: childPath,
          kind: "removed",
          before: preview(before[key]),
          after: null
        });
      } else {
        walkDiff(before[key], after[key], childPath, entries, markTruncated, maxEntries, depth + 1);
      }
    }
    return;
  }

  entries.push({ path, kind: "changed", before: preview(before), after: preview(after) });
}

function addEntry(
  entries: CaptureDiffEntry[],
  markTruncated: () => void,
  maxEntries: number,
  entry: CaptureDiffEntry
): void {
  if (entries.length >= maxEntries) {
    markTruncated();
    return;
  }
  entries.push(entry);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = String(value);
  }
  return text.length > DEFAULT_MAX_VALUE_CHARS
    ? `${text.slice(0, DEFAULT_MAX_VALUE_CHARS)}...`
    : text;
}

function unavailable(reason: "invalid_json" | "truncated"): CaptureDiffResult {
  return {
    available: false,
    equivalent: false,
    reason,
    entries: [],
    truncated: false
  };
}
