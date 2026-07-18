import http, {
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { handleApi } from "./api-routes.js";
import {
  fetchClaudeModels,
  isAnthropicProxyPath,
  proxyClaudeRequest
} from "./claude-proxy.js";
import { CompactionBridgeStore } from "./compaction-bridge.js";
import { ConfigError, ConfigStore } from "./config.js";
import { DebugCaptureWriter } from "./debug-capture.js";
import {
  sendJson,
  statusForError,
  summaryForError
} from "./http-utils.js";
import { RequestLogger, resolveLogDatabasePath } from "./logger.js";
import { proxyOpenAiRequest } from "./openai-proxy.js";
import { fetchOpenAiModels } from "./openai-models.js";
import { PrimaryFailoverState } from "./primary-failover.js";
import { isV1Path } from "./routing.js";
import { serveStatic } from "./static-assets.js";
import { StudioEventBroadcaster } from "./studio-events.js";

export interface CompactGateApp {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

export function createRequestLogger(configStore: ConfigStore): RequestLogger {
  const config = configStore.get();
  return new RequestLogger(
    config.logging.keep_recent,
    resolveLogDatabasePath(configStore.getConfigPath()),
    {
      maxDatabaseBytes: config.logging.max_database_bytes,
      deferStoragePrune: true
    }
  );
}

function createDebugCaptureWriter(
  configStore: ConfigStore,
  logger: RequestLogger,
  studioEvents: StudioEventBroadcaster
): DebugCaptureWriter {
  const config = configStore.get();
  return DebugCaptureWriter.fromConfig(
    config.logging.capture_dir,
    config.logging.capture_body_max_bytes,
    config.logging.capture_dir_max_bytes,
    (capturePath) => {
      for (const entry of logger.markCapturePurged(capturePath)) {
        studioEvents.broadcastLog(entry, "update");
      }
    }
  );
}

export function createCompactGateApp(
  configStore: ConfigStore,
  logger?: RequestLogger,
  captureWriter?: DebugCaptureWriter,
  compactionBridge = new CompactionBridgeStore(),
  studioEvents = new StudioEventBroadcaster()
): CompactGateApp {
  const actualLogger = logger ?? createRequestLogger(configStore);
  const actualCaptureWriter =
    captureWriter ?? createDebugCaptureWriter(configStore, actualLogger, studioEvents);
  const primaryFailover = new PrimaryFailoverState();

  return {
    handler: (req, res) => {
      void routeRequest(
        req,
        res,
        configStore,
        actualLogger,
        actualCaptureWriter,
        compactionBridge,
        studioEvents,
        primaryFailover
      );
    }
  };
}

export function createCompactGateServer(
  configStore: ConfigStore,
  logger?: RequestLogger,
  captureWriter?: DebugCaptureWriter,
  compactionBridge = new CompactionBridgeStore(),
  studioEvents = new StudioEventBroadcaster()
): http.Server {
  const actualLogger = logger ?? createRequestLogger(configStore);
  const actualCaptureWriter =
    captureWriter ?? createDebugCaptureWriter(configStore, actualLogger, studioEvents);
  const app = createCompactGateApp(
    configStore,
    actualLogger,
    actualCaptureWriter,
    compactionBridge,
    studioEvents
  );
  const server = http.createServer(app.handler);
  server.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 426 Upgrade Required\r\n" +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n\r\n"
    );
  });
  server.once("close", () => {
    actualLogger.close();
    studioEvents.close();
  });
  return server;
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  compactionBridge: CompactionBridgeStore,
  studioEvents: StudioEventBroadcaster,
  primaryFailover: PrimaryFailoverState
): Promise<void> {
  try {
    const url = parseRequestUrl(req.url);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(
        req,
        res,
        url,
        configStore,
        logger,
        captureWriter,
        studioEvents,
        fetchClaudeModels,
        fetchOpenAiModels,
        primaryFailover
      );
      return;
    }

    if (isAnthropicProxyPath(url.pathname)) {
      await proxyClaudeRequest(
        req,
        res,
        url,
        configStore,
        logger,
        captureWriter,
        studioEvents
      );
      return;
    }

    if (isV1Path(url.pathname)) {
      await proxyOpenAiRequest(
        req,
        res,
        url,
        configStore,
        logger,
        captureWriter,
        compactionBridge,
        studioEvents,
        primaryFailover
      );
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, statusForError(error), { error: summaryForError(error) });
  }
}

function parseRequestUrl(value: string | undefined): URL {
  try {
    return new URL(value ?? "/", "http://compactgate.local");
  } catch {
    throw new ConfigError("Malformed request URL.");
  }
}
