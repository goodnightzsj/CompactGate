import type { IncomingHttpHeaders } from "node:http";
import { Transform, type TransformCallback } from "node:stream";
import { isRecord } from "../shared/records.js";
import { classifyProviderStateFailure, type ProviderStateFailure } from "./provider-state-errors.js";
import { createOpenAiStreamObserver, type OpenAiStreamObserverHandle, type OpenAiStreamSummary } from "./upstream-openai-stream.js";

const PREFIX_BYTES = 64 * 1024;
const PREFIX_WAIT_MS = 1000;

/** Holds only the pre-output prefix; the caller retains the original wire error for final delivery. */
export class ProviderStateStreamGate extends Transform {
  failure: ProviderStateFailure | null = null;
  private candidate: ProviderStateFailure | null = null;
  private forwarding = false;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly observer: OpenAiStreamObserverHandle | null;
  private observation: Promise<OpenAiStreamSummary | null> | undefined;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(headers: IncomingHttpHeaders) {
    super();
    this.observer = createOpenAiStreamObserver(headers, {
      maxEventBytes: PREFIX_BYTES,
      onEvent: (name, record, data) => this.observeEvent(name, record, data)
    });
    this.timer = setTimeout(() => this.release(), PREFIX_WAIT_MS);
    this.timer.unref();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.forwarding && this.bytes + chunk.length > PREFIX_BYTES) this.release();
    if (this.forwarding) this.push(chunk);
    else {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      this.observer?.observe(chunk);
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    void this.finishObservation().then(summary => {
      clearTimeout(this.timer);
      if (!this.forwarding && this.candidate && !summary?.decodeError && !summary?.oversizedEventCount) {
        this.failure = this.candidate;
        this.chunks = [];
      } else this.release();
      callback();
    }, error => callback(error instanceof Error ? error : new Error(String(error))));
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.timer);
    this.forwarding = true;
    this.chunks = [];
    void this.finishObservation().then(() => callback(error), failure => callback(error ?? failure));
  }

  private finishObservation(): Promise<OpenAiStreamSummary | null> {
    // End a compressed observer once, including when the bounded prefix is released early.
    return this.observation ??= Promise.resolve().then(() => this.observer?.finish() ?? null);
  }

  private release(): void {
    if (this.forwarding || this.destroyed) return;
    this.forwarding = true;
    this.candidate = null;
    clearTimeout(this.timer);
    for (const chunk of this.chunks) this.push(chunk);
    this.chunks = [];
    void this.finishObservation();
  }

  private observeEvent(name: string | null, record: Record<string, unknown> | null, data: string): void {
    if (this.forwarding || this.destroyed) return;
    if (this.candidate && data === "[DONE]") return;
    const type = typeof record?.type === "string" ? record.type : name;
    if (!record || name && typeof record.type === "string" && name !== record.type) { this.release(); return; }
    const response = isRecord(record.response) ? record.response : null;
    const noOutput = (record.output === undefined || Array.isArray(record.output) && record.output.length === 0) &&
      (!response || response.output === undefined || Array.isArray(response.output) && response.output.length === 0);
    if (!this.candidate && noOutput && response && !response.error &&
      (type === "response.created" || type === "response.in_progress")) return;
    if (noOutput && (type === "response.failed" || type === "error")) {
      const error = type === "response.failed" ? response?.error : isRecord(record.error) ? record.error : record;
      const failure = isRecord(error) ? classifyProviderStateFailure(400, Buffer.from(JSON.stringify({ error }))) : null;
      if (failure) { this.candidate = failure; return; }
    }
    // Output items, tool progress, unknown/malformed events and non-state failures commit the stream.
    this.release();
  }
}
