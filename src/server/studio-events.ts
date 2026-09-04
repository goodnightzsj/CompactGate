import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestLogEntry, StudioLogEvent, StudioSnapshotEvent } from "../shared/types.js";
import type { ConfigStore } from "./config.js";
import { healthForConfig } from "./health.js";
import type { RequestLogger } from "./logger.js";
import { stripLogEntryBodies } from "./logger-helpers.js";
import type { CodexVersionMonitor } from "./codex-version.js";
import type { ClientIdentityStore } from "./client-identity-store.js";
import type { CodexVersionStatus } from "../shared/types.js";

interface StudioSseClient {
  keepAliveTimer: ReturnType<typeof setInterval>;
  res: ServerResponse;
}

interface StudioEventBroadcasterOptions {
  maxClients?: number;
}

const DEFAULT_MAX_STUDIO_EVENT_CLIENTS = 64;

export class StudioEventBroadcaster {
  private readonly clients = new Set<StudioSseClient>();

  private readonly maxClients: number;

  constructor(options: StudioEventBroadcasterOptions = {}) {
    this.maxClients = normalizeMaxClients(options.maxClients);
  }

  subscribe(
    req: IncomingMessage,
    res: ServerResponse,
    snapshot: StudioSnapshotEvent
  ): void {
    if (this.clients.size >= this.maxClients) {
      res.writeHead(429, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache"
      });
      res.end("Too many live event clients.");
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    res.flushHeaders?.();

    let client: StudioSseClient;
    const keepAliveTimer = setInterval(() => {
      if (res.destroyed || res.writableEnded || !writeSseChunk(res, ": keep-alive\n\n")) {
        this.disposeClient(client);
      }
    }, 20_000);
    client = { res, keepAliveTimer };

    const cleanup = () => {
      this.disposeClient(client);
    };

    req.once("close", cleanup);
    res.once("close", cleanup);
    res.once("error", cleanup);
    this.clients.add(client);

    if (!writeSseEvent(client.res, "snapshot", snapshot)) {
      this.disposeClient(client);
    }
  }

  broadcastLog(
    entry: RequestLogEntry,
    operation: StudioLogEvent["operation"] = "insert",
    codexStatus?: CodexVersionStatus
  ): void {
    this.broadcast("log", {
      entry: stripLogEntryBodies(entry),
      operation,
      ...(codexStatus ? { codex_status: codexStatus } : {})
    });
  }

  broadcastSnapshot(snapshot: StudioSnapshotEvent): void {
    this.broadcast("snapshot", snapshot);
  }

  close(): void {
    for (const client of [...this.clients]) {
      this.disposeClient(client);
    }
  }

  private broadcast(event: "log" | "snapshot", payload: StudioLogEvent | StudioSnapshotEvent): void {
    if (this.clients.size === 0) {
      return;
    }

    // Serialized once for the whole fan-out. A snapshot carries a full
    // `keep_recent` page, so stringifying it per client repeated megabytes of work
    // for every open Studio tab.
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...this.clients]) {
      if (!writeSseFrame(client.res, frame)) {
        this.disposeClient(client);
      }
    }
  }

  private disposeClient(client: StudioSseClient): void {
    if (!this.clients.delete(client)) {
      return;
    }

    clearInterval(client.keepAliveTimer);
    if (!client.res.destroyed && !client.res.writableEnded) {
      client.res.end();
    }
  }
}

export function createStudioSnapshot(
  configStore: ConfigStore,
  logger: RequestLogger,
  codexVersionMonitor: CodexVersionMonitor,
  clientIdentity: ClientIdentityStore
): StudioSnapshotEvent {
  const logPage = logger.page({
    limit: configStore.get().logging.keep_recent,
    offset: 0
  });

  return {
    config: configStore.toPublicConfig(),
    health: healthForConfig(configStore.get(), logger, codexVersionMonitor, clientIdentity),
    logs: logPage.logs,
    log_page: logPage
  };
}

function writeSseEvent(
  res: ServerResponse,
  event: "log" | "snapshot",
  payload: StudioLogEvent | StudioSnapshotEvent
): boolean {
  return writeSseFrame(res, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function writeSseFrame(res: ServerResponse, frame: string): boolean {
  if (res.destroyed || res.writableEnded) {
    return false;
  }

  try {
    return writeSseChunk(res, frame);
  } catch {
    return false;
  }
}

/**
 * A snapshot carries a whole `keep_recent` log page — up to 2000 rows — so a
 * client that has stopped reading (a suspended laptop, a zero-window socket)
 * accumulates megabytes per broadcast. `res.write()` returning false is
 * backpressure rather than failure and never throws, so treating the write as
 * successful meant nothing reaped that client and nothing bounded its buffer: a
 * single dead tab held 41 MB after 40 broadcasts, and the keep-alive comment kept
 * "succeeding" into the same buffer forever.
 *
 * The cap is generous enough to absorb several ordinary snapshots back to back.
 * Past it the client is dropped, which is what the documented contract already
 * said happens on a failed write — Studio reconnects on its own and gets a fresh
 * snapshot, so the cost of being wrong here is one reconnect.
 */
const MAX_STUDIO_EVENT_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;

function writeSseChunk(res: ServerResponse, chunk: string): boolean {
  try {
    res.write(chunk);
    // Backpressure by itself must NOT drop the client: a slow but healthy tab
    // returns false routinely, and disconnecting on the first false would churn
    // every such tab. Only a buffer that has actually grown past the cap counts.
    // An unmeasurable buffer keeps the client — never disconnect over a number we
    // could not read.
    const buffered = res.writableLength;
    return typeof buffered !== "number" || buffered <= MAX_STUDIO_EVENT_CLIENT_BUFFER_BYTES;
  } catch {
    return false;
  }
}

function normalizeMaxClients(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_STUDIO_EVENT_CLIENTS;
  }

  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_MAX_STUDIO_EVENT_CLIENTS;
}
