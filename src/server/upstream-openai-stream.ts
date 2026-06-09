import type { IncomingHttpHeaders } from "node:http";

export interface OpenAiStreamSummary {
  sawTerminalEvent: boolean;
  sawCompletedEvent: boolean;
  sawFailedEvent: boolean;
  sawIncompleteEvent: boolean;
  sawOutputEvent: boolean;
  sawDoneMarker: boolean;
  eventCount: number;
}

export interface OpenAiStreamObserverOptions {
  maxEventBytes?: number;
}

const DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES = 64 * 1024;

export function createOpenAiStreamObserver(
  headers: IncomingHttpHeaders,
  options: OpenAiStreamObserverOptions = {}
): OpenAiStreamObserver | null {
  const contentType = readHeader(headers["content-type"])?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream")
    ? new OpenAiStreamObserver(normalizeMaxEventBytes(options.maxEventBytes))
    : null;
}

class OpenAiStreamObserver {
  private pending = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];
  private retainedEventBytes = 0;
  private oversizedEvent = false;
  private discardingLine = false;
  private summary: OpenAiStreamSummary = {
    sawTerminalEvent: false,
    sawCompletedEvent: false,
    sawFailedEvent: false,
    sawIncompleteEvent: false,
    sawOutputEvent: false,
    sawDoneMarker: false,
    eventCount: 0
  };

  constructor(private readonly maxEventBytes: number) {}

  observe(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    let offset = 0;

    while (offset < text.length) {
      const newlineIndex = text.indexOf("\n", offset);
      const hasNewline = newlineIndex !== -1;
      const segment = text.slice(offset, hasNewline ? newlineIndex : text.length);
      this.observeLineSegment(segment, hasNewline);
      offset = hasNewline ? newlineIndex + 1 : text.length;
    }
  }

  finish(): OpenAiStreamSummary {
    if (this.pending.length > 0) {
      this.observeLine(this.pending);
      this.pending = "";
    }
    this.flushEvent();
    return { ...this.summary };
  }

  private observeLine(line: string): void {
    if (line === "") {
      this.flushEvent();
      return;
    }

    if (this.oversizedEvent || !this.retainEventLine(line)) {
      return;
    }

    if (line.startsWith("event:")) {
      this.eventName = line.slice("event:".length).trim();
      return;
    }

    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  private flushEvent(): void {
    if (this.oversizedEvent) {
      this.resetEvent();
      return;
    }

    if (!this.eventName && this.dataLines.length === 0) {
      this.resetEvent();
      return;
    }

    this.summary.eventCount += 1;
    const data = this.dataLines.join("\n").trim();
    if (data === "[DONE]") {
      this.summary.sawDoneMarker = true;
      this.summary.sawTerminalEvent = true;
    }

    const eventType = this.readEventType(data);
    if (isOpenAiTerminalEvent(this.eventName) || isOpenAiTerminalEvent(eventType)) {
      this.summary.sawTerminalEvent = true;
    }
    if (isOpenAiCompletedEvent(this.eventName) || isOpenAiCompletedEvent(eventType)) {
      this.summary.sawCompletedEvent = true;
    }
    if (isOpenAiFailedEvent(this.eventName) || isOpenAiFailedEvent(eventType)) {
      this.summary.sawFailedEvent = true;
    }
    if (isOpenAiIncompleteEvent(this.eventName) || isOpenAiIncompleteEvent(eventType)) {
      this.summary.sawIncompleteEvent = true;
    }
    if (isOpenAiOutputEvent(this.eventName) || isOpenAiOutputEvent(eventType) || hasOpenAiOutputPayload(data)) {
      this.summary.sawOutputEvent = true;
    }

    this.eventName = null;
    this.dataLines = [];
    this.retainedEventBytes = 0;
  }

  private readEventType(data: string): string | null {
    if (!data || data === "[DONE]") {
      return null;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed) && typeof parsed.type === "string") {
        return parsed.type;
      }
    } catch {
      return null;
    }

    return null;
  }

  private observeLineSegment(segment: string, lineComplete: boolean): void {
    if (!this.discardingLine) {
      this.appendPendingSegment(segment);
    }

    if (!lineComplete) {
      return;
    }

    if (this.discardingLine) {
      this.discardingLine = false;
      this.pending = "";
      return;
    }

    const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    this.pending = "";
    this.observeLine(line);
  }

  private appendPendingSegment(segment: string): void {
    if (segment.length === 0) {
      return;
    }

    const nextPending = `${this.pending}${segment}`;
    if (this.retainedEventBytes + Buffer.byteLength(nextPending, "utf8") > this.maxEventBytes) {
      this.markEventOversized();
      this.discardingLine = true;
      return;
    }

    this.pending = nextPending;
  }

  private retainEventLine(line: string): boolean {
    const nextBytes = this.retainedEventBytes + Buffer.byteLength(line, "utf8");
    if (nextBytes > this.maxEventBytes) {
      this.markEventOversized();
      return false;
    }

    this.retainedEventBytes = nextBytes;
    return true;
  }

  private markEventOversized(): void {
    this.pending = "";
    this.eventName = null;
    this.dataLines = [];
    this.retainedEventBytes = 0;
    this.oversizedEvent = true;
  }

  private resetEvent(): void {
    this.eventName = null;
    this.dataLines = [];
    this.retainedEventBytes = 0;
    this.oversizedEvent = false;
  }
}

function isOpenAiTerminalEvent(type: string | null): boolean {
  return type === "response.completed" || type === "response.failed" || type === "response.incomplete";
}

function isOpenAiCompletedEvent(type: string | null): boolean {
  return type === "response.completed";
}

function isOpenAiFailedEvent(type: string | null): boolean {
  return type === "response.failed";
}

function isOpenAiIncompleteEvent(type: string | null): boolean {
  return type === "response.incomplete";
}

function isOpenAiOutputEvent(type: string | null): boolean {
  if (!type) {
    return false;
  }

  return (
    type === "response.output_text.delta" ||
    type === "response.output_item.done" ||
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_summary_part.added" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta" ||
    type.endsWith(".delta")
  );
}

function hasOpenAiOutputPayload(data: string): boolean {
  if (!data || data === "[DONE]") {
    return false;
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) {
      return false;
    }

    const delta = parsed.delta;
    if (typeof delta === "string" && delta.length > 0) {
      return true;
    }

    if (Array.isArray(parsed.output) && parsed.output.length > 0) {
      return true;
    }

    const response = parsed.response;
    return isRecord(response) && Array.isArray(response.output) && response.output.length > 0;
  } catch {
    return false;
  }
}

function readHeader(value: IncomingHttpHeaders[string]): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMaxEventBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES;
  }

  return Math.max(0, Math.floor(value));
}
