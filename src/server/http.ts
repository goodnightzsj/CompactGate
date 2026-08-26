import http, {
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { handleConfigApi } from "./api-config-routes.js";
import { handleRuntimeApi } from "./api-runtime-routes.js";
import {
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
import { PrimaryFailoverState } from "./primary-failover.js";
import { ClaudeKeyPoolState } from "./claude-key-pool.js";
import { isV1Path } from "./routing.js";
import { serveStatic } from "./static-assets.js";
import { createStudioSnapshot, StudioEventBroadcaster } from "./studio-events.js";
import { CodexVersionMonitor } from "./codex-version.js";

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

/**
 * Past this many rows in one prune pass, converge open Studios with a single
 * snapshot instead of one `update` frame each. Lowering the directory cap can
 * purge the entire capture directory at once, and the per-row loop wrote every
 * frame synchronously to every connected client.
 */
const CAPTURE_PURGE_SNAPSHOT_THRESHOLD = 50;

function createDebugCaptureWriter(
  configStore: ConfigStore,
  logger: RequestLogger,
  studioEvents: StudioEventBroadcaster,
  codexVersionMonitor: CodexVersionMonitor
): DebugCaptureWriter {
  const config = configStore.get();
  return DebugCaptureWriter.fromConfig(
    config.logging.capture_dir,
    config.logging.capture_body_max_bytes,
    config.logging.capture_dir_max_bytes,
    (capturePaths) => {
      const entries = logger.markCapturesPurged(capturePaths, CAPTURE_PURGE_SNAPSHOT_THRESHOLD);
      if (capturePaths.length > CAPTURE_PURGE_SNAPSHOT_THRESHOLD) {
        studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger, codexVersionMonitor));
        return;
      }
      if (entries.length === 0) {
        return;
      }

      for (const entry of entries) {
        studioEvents.broadcastLog(entry, "update");
      }
    }
  );
}

export function createCompactGateServer(
  configStore: ConfigStore,
  logger?: RequestLogger,
  captureWriter?: DebugCaptureWriter,
  compactionBridge = new CompactionBridgeStore(),
  studioEvents = new StudioEventBroadcaster(),
  codexVersionMonitor = new CodexVersionMonitor()
): http.Server {
  const actualLogger = logger ?? createRequestLogger(configStore);
  const actualCaptureWriter =
    captureWriter ??
    createDebugCaptureWriter(configStore, actualLogger, studioEvents, codexVersionMonitor);
  const primaryFailover = new PrimaryFailoverState();
  const claudeKeyPool = new ClaudeKeyPoolState();
  codexVersionMonitor.start();
  const server = http.createServer((req, res) => {
    void routeRequest(
      req,
      res,
      configStore,
      actualLogger,
      actualCaptureWriter,
      compactionBridge,
      studioEvents,
      primaryFailover,
      codexVersionMonitor,
      claudeKeyPool
    );
  });
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
    codexVersionMonitor.close();
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
  primaryFailover: PrimaryFailoverState,
  codexVersionMonitor: CodexVersionMonitor,
  claudeKeyPool: ClaudeKeyPoolState
): Promise<void> {
  try {
    const url = parseRequestUrl(req.url);

    if (url.pathname.startsWith("/api/")) {
      const handled =
        await handleConfigApi(
          req, res, url, configStore, logger, captureWriter, studioEvents,
          codexVersionMonitor, primaryFailover
        ) ||
        await handleRuntimeApi(
          req, res, url, configStore, logger, captureWriter, studioEvents,
          primaryFailover, codexVersionMonitor
        );
      if (!handled) {
        sendJson(res, 404, { error: "API endpoint not found." });
      }
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
        studioEvents,
        claudeKeyPool
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
        primaryFailover,
        codexVersionMonitor
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
