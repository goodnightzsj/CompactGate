import type { IncomingHttpHeaders } from "node:http";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress
} from "node:zlib";
import { extractResponseModelFromText } from "./response-model.js";
import { mergeUsage } from "./usage-merge.js";
import { extractUsageFromJsonText } from "./usage-record.js";
import type { TokenUsageMetrics } from "./usage-types.js";

export interface OpenAiStreamSummary {
  sawTerminalEvent: boolean;
  sawCompletedEvent: boolean;
  sawFailedEvent: boolean;
  sawIncompleteEvent: boolean;
  sawOutputEvent: boolean;
  sawDoneMarker: boolean;
  terminalEvent: string | null;
  eventCount: number;
  oversizedEventCount: number;
  decodeError: boolean;
  errorSummary: string | null;
  responseModel: string | null;
  usage: TokenUsageMetrics | null;
}

export interface OpenAiStreamObserverOptions {
  maxEventBytes?: number;
}

type StreamProtocol = "openai" | "anthropic";

export interface OpenAiStreamObserverHandle {
  observe(chunk: Buffer): void;
  snapshot(): OpenAiStreamSummary;
  finish(): Promise<OpenAiStreamSummary>;
}

const DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES = 64 * 1024;

export function createOpenAiStreamObserver(
  headers: IncomingHttpHeaders,
  options: OpenAiStreamObserverOptions = {}
): OpenAiStreamObserverHandle | null {
  return createProtocolStreamObserver(headers, "openai", options);
}

export function createAnthropicStreamObserver(
  headers: IncomingHttpHeaders,
  options: OpenAiStreamObserverOptions = {}
): OpenAiStreamObserverHandle | null {
  return createProtocolStreamObserver(headers, "anthropic", options);
}

function createProtocolStreamObserver(
  headers: IncomingHttpHeaders,
  protocol: StreamProtocol,
  options: OpenAiStreamObserverOptions
): OpenAiStreamObserverHandle | null {
  const contentType = readHeader(headers["content-type"])?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    return null;
  }

  const observer = new OpenAiStreamObserver(
    protocol,
    normalizeMaxEventBytes(options.maxEventBytes)
  );
  const contentEncoding = readHeader(headers["content-encoding"])?.toLowerCase() ?? "";
  if (contentEncoding.includes("br")) {
    return new CompressedOpenAiStreamObserver(observer, createBrotliDecompress());
  }
  if (contentEncoding.includes("gzip")) {
    return new CompressedOpenAiStreamObserver(observer, createGunzip());
  }
  if (contentEncoding.includes("deflate")) {
    return new CompressedOpenAiStreamObserver(observer, createInflate());
  }
  if (contentEncoding.includes("zstd")) {
    return new CompressedOpenAiStreamObserver(observer, createZstdDecompress());
  }
  return observer;
}

class OpenAiStreamObserver implements OpenAiStreamObserverHandle {
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
    terminalEvent: null,
    eventCount: 0,
    oversizedEventCount: 0,
    decodeError: false,
    errorSummary: null,
    responseModel: null,
    usage: null
  };

  constructor(
    private readonly protocol: StreamProtocol,
    private readonly maxEventBytes: number
  ) {}

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

  snapshot(): OpenAiStreamSummary {
    return { ...this.summary };
  }

  async finish(): Promise<OpenAiStreamSummary> {
    if (this.pending.length > 0) {
      this.observeLine(this.pending);
      this.pending = "";
    }
    this.flushEvent();
    return { ...this.summary };
  }

  markDecodeError(): void {
    this.summary.decodeError = true;
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
      if (this.eventName) {
        this.summary.eventCount += 1;
        this.recordEvent(this.eventName, null, "");
      }
      this.resetEvent();
      return;
    }

    if (!this.eventName && this.dataLines.length === 0) {
      this.resetEvent();
      return;
    }

    this.summary.eventCount += 1;
    const data = this.dataLines.join("\n").trim();
    const eventType = this.readEventType(data);
    this.recordEvent(this.eventName, eventType, data);

    this.eventName = null;
    this.dataLines = [];
    this.retainedEventBytes = 0;
  }

  private recordEvent(eventName: string | null, eventType: string | null, data: string): void {
    this.recordMetadata(data);

    if (this.protocol === "anthropic") {
      this.recordAnthropicEvent(eventName, eventType, data);
      return;
    }

    if (data === "[DONE]") {
      this.summary.sawDoneMarker = true;
      this.summary.sawTerminalEvent = true;
      this.summary.terminalEvent = "[DONE]";
    }

    if (isOpenAiTerminalEvent(eventName) || isOpenAiTerminalEvent(eventType)) {
      this.summary.sawTerminalEvent = true;
      this.summary.terminalEvent = terminalEventName(
        eventName,
        eventType,
        isOpenAiTerminalEvent
      );
    }
    if (isOpenAiCompletedEvent(eventName) || isOpenAiCompletedEvent(eventType)) {
      this.summary.sawCompletedEvent = true;
    }
    if (isOpenAiFailedEvent(eventName) || isOpenAiFailedEvent(eventType)) {
      this.summary.sawFailedEvent = true;
    }
    if (isOpenAiIncompleteEvent(eventName) || isOpenAiIncompleteEvent(eventType)) {
      this.summary.sawIncompleteEvent = true;
    }
    if (isOpenAiOutputEvent(eventName) || isOpenAiOutputEvent(eventType) || hasOpenAiOutputPayload(data)) {
      this.summary.sawOutputEvent = true;
    }
  }

  private recordAnthropicEvent(
    eventName: string | null,
    eventType: string | null,
    data: string
  ): void {
    if (isAnthropicCompletedEvent(eventName) || isAnthropicCompletedEvent(eventType)) {
      this.summary.sawTerminalEvent = true;
      this.summary.sawCompletedEvent = true;
      this.summary.terminalEvent = terminalEventName(
        eventName,
        eventType,
        isAnthropicCompletedEvent
      );
    }

    if (isAnthropicErrorEvent(eventName) || isAnthropicErrorEvent(eventType)) {
      this.summary.sawTerminalEvent = true;
      this.summary.sawFailedEvent = true;
      this.summary.terminalEvent = terminalEventName(
        eventName,
        eventType,
        isAnthropicErrorEvent
      );
      this.summary.errorSummary ??= extractAnthropicErrorSummary(data);
    }

    if (isAnthropicOutputEvent(eventName) || isAnthropicOutputEvent(eventType)) {
      this.summary.sawOutputEvent = true;
    }
  }

  private recordMetadata(data: string): void {
    if (!data || data === "[DONE]") {
      return;
    }

    const usage = extractUsageFromJsonText(data);
    if (usage) {
      this.summary.usage = mergeUsage(this.summary.usage, usage);
    }

    this.summary.responseModel ??= extractResponseModelFromText(data);
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
    this.dataLines = [];
    this.retainedEventBytes = 0;
    if (!this.oversizedEvent) {
      this.summary.oversizedEventCount += 1;
    }
    this.oversizedEvent = true;
  }

  private resetEvent(): void {
    this.eventName = null;
    this.dataLines = [];
    this.retainedEventBytes = 0;
    this.oversizedEvent = false;
  }
}

class CompressedOpenAiStreamObserver implements OpenAiStreamObserverHandle {
  private readonly completion: Promise<void>;

  constructor(
    private readonly observer: OpenAiStreamObserver,
    private readonly decoder: ReturnType<typeof createGunzip>
  ) {
    this.decoder.on("data", (chunk: Buffer) => this.observer.observe(chunk));
    this.completion = new Promise((resolve) => {
      this.decoder.once("end", resolve);
      this.decoder.once("error", () => {
        this.observer.markDecodeError();
        resolve();
      });
    });
  }

  observe(chunk: Buffer): void {
    this.decoder.write(chunk);
  }

  snapshot(): OpenAiStreamSummary {
    return this.observer.snapshot();
  }

  async finish(): Promise<OpenAiStreamSummary> {
    this.decoder.end();
    await this.completion;
    return this.observer.finish();
  }
}

function isAnthropicCompletedEvent(type: string | null): boolean {
  return type === "message_stop";
}

function isAnthropicErrorEvent(type: string | null): boolean {
  return type === "error";
}

function isAnthropicOutputEvent(type: string | null): boolean {
  return type === "content_block_start" || type === "content_block_delta";
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

function extractAnthropicErrorSummary(data: string): string | null {
  if (!data) {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.error)) {
      return null;
    }

    const message = readNonEmptyString(parsed.error.message);
    const qualifier = readNonEmptyString(parsed.error.type) ?? readNonEmptyString(parsed.error.code);
    const summary = message && qualifier && !message.includes(qualifier)
      ? `${message} (${qualifier})`
      : message ?? qualifier;
    if (!summary) {
      return null;
    }

    return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
  } catch {
    return null;
  }
}

function terminalEventName(
  eventName: string | null,
  eventType: string | null,
  isTerminal: (value: string | null) => boolean
): string | null {
  return isTerminal(eventName) ? eventName : eventType;
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

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  return text.length > 0 ? text : null;
}

function normalizeMaxEventBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES;
  }

  return Math.max(0, Math.floor(value));
}
