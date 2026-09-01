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

/**
 * Why a rejection reason rather than a boolean: the two headers fail for different
 * reasons and the operator needs to know which. A foreign `Origin` is a page
 * driving the API; a foreign `Host` is DNS rebinding, where a name the attacker
 * controls resolves to loopback so the request looks local. An absent header is
 * not suspicious — no browser omits `Origin` on a cross-origin write, and CLI
 * callers omit both.
 */
export function crossSiteApiRejection(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0 && origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return "Admin API rejected a request with an unparsable Origin.";
    }
    if (!isLoopbackHostname(originHost)) {
      return "Admin API is reachable from this machine only; cross-site Origin refused.";
    }
  }

  const host = req.headers.host;
  if (typeof host === "string" && host.length > 0 && !isLoopbackHostname(hostnameOf(host))) {
    return "Admin API is reachable through a loopback address only; Host refused.";
  }

  return null;
}

function hostnameOf(hostHeader: string): string {
  // `Host` carries no scheme, and an IPv6 literal keeps its brackets, so the port
  // cannot be split off with a plain lastIndexOf(":").
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return name === "localhost" ||
    name === "::1" ||
    name === "0:0:0:0:0:0:0:1" ||
    // The whole 127/8 block is loopback, not just 127.0.0.1.
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
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
      // The admin API has no credential of its own, so a browser page the user
      // happens to visit was able to drive it: `readJsonBody` ignores
      // Content-Type, which makes a `text/plain` POST a CORS "simple request"
      // that needs no preflight, and the write lands before any response is read.
      // Pointing `primary.base_url` at an attacker that way hands over every key
      // and conversation that follows. Both headers below are set by browsers and
      // omitted by CLI callers, so loopback-only checks close the hole without
      // touching curl, the e2e script, or the agent launchers.
      const forbidden = crossSiteApiRejection(req);
      if (forbidden) {
        sendJson(res, 403, { error: forbidden });
        return;
      }

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
