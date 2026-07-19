import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestLogEntry, StudioLogEvent, StudioSnapshotEvent } from "../shared/types.js";
import type { ConfigStore } from "./config.js";
import { healthForConfig } from "./health.js";
import type { RequestLogger } from "./logger.js";
import { stripLogEntryBodies } from "./logger-helpers.js";
import type { CodexVersionMonitor } from "./codex-version.js";
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
    for (const client of [...this.clients]) {
      if (!writeSseEvent(client.res, event, payload)) {
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
  codexVersionMonitor: CodexVersionMonitor
): StudioSnapshotEvent {
  const logPage = logger.page({
    limit: configStore.get().logging.keep_recent,
    offset: 0
  });

  return {
    config: configStore.toPublicConfig(),
    health: healthForConfig(configStore.get(), logger, codexVersionMonitor),
    logs: logPage.logs,
    log_page: logPage
  };
}

function writeSseEvent(
  res: ServerResponse,
  event: "log" | "snapshot",
  payload: StudioLogEvent | StudioSnapshotEvent
): boolean {
  if (res.destroyed || res.writableEnded) {
    return false;
  }

  try {
    return (
      writeSseChunk(res, `event: ${event}\n`) &&
      writeSseChunk(res, `data: ${JSON.stringify(payload)}\n\n`)
    );
  } catch {
    return false;
  }
}

function writeSseChunk(res: ServerResponse, chunk: string): boolean {
  try {
    res.write(chunk);
    return true;
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
