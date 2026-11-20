import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigProfileScope, RequestLogEntry, StudioKeyActivityEvent, StudioLogEvent, StudioSnapshotEvent } from "../shared/types.js";
import type { ConfigStore } from "./config.js";
import { healthForConfig } from "./health.js";
import type { RequestLogger } from "./logger.js";
import { stripLogEntryBodies } from "./logger-helpers.js";
import type { CodexVersionMonitor } from "./codex-version.js";
import type { ClientIdentityStore } from "./client-identity-store.js";
import type { CodexVersionStatus } from "../shared/types.js";

interface StudioSseClient {
  keepAliveTimer: ReturnType<typeof setInterval>;
  drainTimer: ReturnType<typeof setTimeout> | null;
  req: IncomingMessage;
  res: ServerResponse;
  queue: Buffer[];
  queuedBytes: number;
  offset: number;
  cleanup: () => void;
  drain: () => void;
}

interface StudioEventBroadcasterOptions {
  maxClients?: number;
}

const DEFAULT_MAX_STUDIO_EVENT_CLIENTS = 64;
const MAX_STUDIO_EVENT_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024;
const STUDIO_WRITE_CHUNK_BYTES = 64 * 1024;
const STUDIO_DRAIN_TIMEOUT_MS = 30_000;

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
      if (res.destroyed || res.writableEnded) {
        this.disposeClient(client);
      } else if (client.queue.length === 0 && !client.drainTimer) {
        this.enqueue(client, Buffer.from(": keep-alive\n\n"));
      }
    }, 20_000);
    client = { req, res, keepAliveTimer, drainTimer: null, queue: [], queuedBytes: 0, offset: 0,
      cleanup: () => this.disposeClient(client),
      drain: () => {
        if (client.drainTimer) clearTimeout(client.drainTimer);
        client.drainTimer = null;
        this.flush(client);
      }
    };

    req.once("close", client.cleanup);
    res.once("close", client.cleanup);
    res.once("error", client.cleanup);
    this.clients.add(client);

    this.enqueue(client, Buffer.from(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
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

  broadcastKeyActivity(scope: ConfigProfileScope, profileId: string | null, keyId: string | null, configRevision: string): void {
    if (!keyId) return;
    this.broadcast("key_activity", {
      scope, profile_id: profileId, key_id: keyId,
      used_at: new Date().toISOString(), config_revision: configRevision
    });
  }

  close(): void {
    for (const client of [...this.clients]) {
      this.disposeClient(client);
    }
  }

  private broadcast(event: "log" | "snapshot" | "key_activity", payload: StudioLogEvent | StudioSnapshotEvent | StudioKeyActivityEvent): void {
    if (this.clients.size === 0) {
      return;
    }

    // Serialized once for the whole fan-out. A snapshot carries a full
    // `keep_recent` page, so stringifying it per client repeated megabytes of work
    // for every open Studio tab.
    const frame = Buffer.from(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const client of [...this.clients]) {
      this.enqueue(client, frame);
    }
  }

  private enqueue(client: StudioSseClient, frame: Buffer): void {
    // One legal frame may exceed the backlog budget; subsequent queued frames may not.
    const backlog = client.queue.length > 0 ? client.queuedBytes - client.queue[0].byteLength : 0;
    if (client.queue.length > 0 && backlog + frame.byteLength > MAX_STUDIO_EVENT_CLIENT_BUFFER_BYTES) {
      this.disposeClient(client, true);
      return;
    }
    client.queue.push(frame);
    client.queuedBytes += frame.byteLength;
    if (!client.drainTimer) this.flush(client);
  }

  private flush(client: StudioSseClient): void {
    if (!this.clients.has(client)) return;
    if (client.res.destroyed || client.res.writableEnded) return this.disposeClient(client);
    try {
      while (client.queue.length > 0) {
        const frame = client.queue[0];
        const end = Math.min(client.offset + STUDIO_WRITE_CHUNK_BYTES, frame.byteLength);
        const writable = client.res.write(frame.subarray(client.offset, end));
        client.offset = end;
        if (end === frame.byteLength) {
          client.queue.shift();
          client.queuedBytes -= frame.byteLength;
          client.offset = 0;
        }
        if (writable === false) {
          client.res.once("drain", client.drain);
          client.drainTimer = setTimeout(() => this.disposeClient(client, true), STUDIO_DRAIN_TIMEOUT_MS);
          client.drainTimer.unref();
          return;
        }
      }
    } catch {
      this.disposeClient(client);
    }
  }

  private disposeClient(client: StudioSseClient, stalled = false): void {
    if (!this.clients.delete(client)) {
      return;
    }

    clearInterval(client.keepAliveTimer);
    if (client.drainTimer) clearTimeout(client.drainTimer);
    client.drainTimer = null;
    client.queue.length = 0;
    client.queuedBytes = 0;
    client.req.off("close", client.cleanup);
    client.res.off("close", client.cleanup);
    client.res.off("drain", client.drain);
    if (stalled) client.res.destroy();
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
    health: healthForConfig(configStore.get(), logger, codexVersionMonitor, clientIdentity, configStore.oauth),
    logs: logPage.logs,
    log_page: logPage
  };
}

function normalizeMaxClients(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_STUDIO_EVENT_CLIENTS;
  }

  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_MAX_STUDIO_EVENT_CLIENTS;
}
