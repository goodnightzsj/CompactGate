import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestLogEntry, StudioLogEvent, StudioSnapshotEvent } from "../shared/types.js";
import type { ConfigStore } from "./config.js";
import { healthForConfig } from "./health.js";
import type { RequestLogger } from "./logger.js";

interface StudioSseClient {
  keepAliveTimer: ReturnType<typeof setInterval>;
  res: ServerResponse;
}

export class StudioEventBroadcaster {
  private readonly clients = new Set<StudioSseClient>();

  subscribe(
    req: IncomingMessage,
    res: ServerResponse,
    snapshot: StudioSnapshotEvent
  ): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    res.flushHeaders?.();

    const client: StudioSseClient = {
      res,
      keepAliveTimer: setInterval(() => {
        if (!res.destroyed && !res.writableEnded) {
          res.write(": keep-alive\n\n");
        }
      }, 20_000)
    };

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

  broadcastLog(entry: RequestLogEntry): void {
    this.broadcast("log", { entry });
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
  logger: RequestLogger
): StudioSnapshotEvent {
  const logPage = logger.page({
    limit: configStore.get().logging.keep_recent,
    offset: 0
  });

  return {
    config: configStore.toPublicConfig(),
    health: healthForConfig(configStore.get()),
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
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}
