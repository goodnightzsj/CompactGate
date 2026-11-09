import { Worker } from "node:worker_threads";
import type { LogAnalyticsSnapshot } from "../shared/types.js";
import type { LogStatsOptions } from "./logger-analytics.js";

const MAX_PENDING_STATS = 8;
const STATS_TIMEOUT_MS = 60_000;

export class LogStatsBusyError extends Error {
  constructor() {
    super("Log statistics are busy; retry after the current queries finish.");
    this.name = "LogStatsBusyError";
  }
}

interface StatsJob {
  id: number;
  options: LogStatsOptions;
  complete(snapshot?: LogAnalyticsSnapshot, error?: unknown): void;
}

type StatsReply = {
  id: number;
  snapshot?: LogAnalyticsSnapshot;
  error?: { name: string; message: string };
};

export class LogStatsReader {
  private worker: Worker | null = null;
  private stopping: Promise<void> | null = null;
  private closed = false;
  private sequence = 0;
  private active: StatsJob | null = null;
  private readonly queue: StatsJob[] = [];
  private deadline: NodeJS.Timeout | null = null;

  constructor(private readonly databasePath: string) {}

  read(options: LogStatsOptions, signal?: AbortSignal): Promise<LogAnalyticsSnapshot> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.reject(new Error("Log statistics reader is closed."));
    if (this.stopping || this.queue.length + Number(this.active !== null) >= MAX_PENDING_STATS) {
      return Promise.reject(new LogStatsBusyError());
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const job: StatsJob = {
        id: ++this.sequence,
        options: { ...options },
        complete(snapshot, error) {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          if (error !== undefined) reject(error);
          else resolve(snapshot!);
        }
      };
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        // SQLite cannot be interrupted on Node 22; retain the active slot until it finishes.
        job.complete(undefined, signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.dispatch();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    this.failPending(new Error("Log statistics reader is closed."));
    return this.stopWorker();
  }

  private dispatch(): void {
    if (this.active || this.queue.length === 0 || this.closed) return;
    this.active = this.queue.shift()!;
    try {
      const worker = this.worker ?? this.startWorker();
      worker.ref();
      this.deadline = setTimeout(() => {
        this.failPending(new Error("Log statistics query exceeded its 60 second deadline."));
        void this.stopWorker();
      }, STATS_TIMEOUT_MS);
      worker.postMessage({ id: this.active.id, options: this.active.options });
    } catch (error) {
      this.failPending(error);
      void this.stopWorker();
    }
  }

  private startWorker(): Worker {
    const source = import.meta.url.endsWith(".ts");
    const entry = new URL(source ? "./log-stats-worker.ts" : "./log-stats-worker.js", import.meta.url);
    // Development uses the installed TS loader; compiled deployments only load JavaScript.
    const url = source ? new URL(`data:text/javascript,${encodeURIComponent(
      `import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};\n` +
      `await tsImport(${JSON.stringify(entry.href)}, ${JSON.stringify(import.meta.url)});`
    )}`) : entry;
    const worker = new Worker(url, {
      workerData: { databasePath: this.databasePath },
      execArgv: [],
      name: "compactgate-log-stats"
    });
    this.worker = worker;
    worker.on("message", (reply: StatsReply) => {
      if (this.worker !== worker || reply.id !== this.active?.id) return;
      this.clearDeadline();
      const error = reply.error ? Object.assign(new Error(reply.error.message), { name: reply.error.name }) : undefined;
      this.active.complete(reply.snapshot, error);
      this.active = null;
      worker.unref();
      this.dispatch();
    });
    worker.once("error", (error) => {
      if (this.worker !== worker) return;
      this.failPending(error);
      void this.stopWorker();
    });
    worker.once("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.failPending(new Error(`Log statistics worker exited unexpectedly (${code}).`));
    });
    return worker;
  }

  private failPending(error: unknown): void {
    this.clearDeadline();
    this.active?.complete(undefined, error);
    this.active = null;
    for (const job of this.queue.splice(0)) job.complete(undefined, error);
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }

  private stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return this.stopping ?? Promise.resolve();
    const stopping = worker.terminate().then(() => undefined);
    this.stopping = stopping;
    void stopping.then(() => {
      this.stopping = null;
    }, (error) => {
      this.stopping = null;
      console.error("Log statistics worker shutdown failed.", error);
    });
    return stopping;
  }
}
