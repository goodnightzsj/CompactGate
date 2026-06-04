import http, {
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse
} from "node:http";
import https, { Agent as HttpsAgent } from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { createReadStream, existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type {
  CompactGateConfig,
  HealthResponse,
  LogStatusKind,
  RequestLogEntry,
  RequestLogPage,
  RequestTransport,
  RouteKind,
  StudioLogEvent,
  StudioSnapshotEvent
} from "../shared/types.js";
import { CompactionBridgeStore } from "./compaction-bridge.js";
import {
  type ClaudeSummaryRecord,
  ClaudeSummaryStore,
  resolveClaudeSummaryDatabasePath
} from "./claude-summary-store.js";
import { ConfigError, ConfigStore } from "./config.js";
import { resolveRouteCredential } from "./credentials.js";
import {
  DebugCaptureWriter,
  serializeBody,
  serializeHeaders,
  type CaptureRecord
} from "./debug-capture.js";
import { RequestLogger, resolveLogDatabasePath } from "./logger.js";
import {
  buildUpstreamUrl,
  compactUpstreamBaseUrl,
  extractJsonModel,
  isV1Path,
  previewRoute,
  rewriteCompactBody,
  routeForPath
} from "./routing.js";
import {
  extractRequestMetadata,
  extractResponseErrorSummary,
  extractResponseUsage,
  extractSourceModel,
  responseTransport,
  type RequestMetadata,
  type TokenUsageMetrics
} from "./usage.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const STATIC_MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const ANTHROPIC_PROXY_PREFIX = "/anthropic";
const CLAUDE_AUTO_COMPACT_SUMMARY_TOKENS = 512;
const CLAUDE_RECONNECT_AUTO_COMPACT_MIN_COUNT = 5;

type ClaudeSubRoute = "primary" | "compact";
type ClaudeRetryReason = "none" | "reconnect";

interface ClaudeSummaryContext {
  cacheKey: string;
  messageCount: number;
  sourceModel: string | null;
}

interface ClaudeRetryAttempt {
  result: BufferedUpstreamResult;
  upstream: URL;
  requestHeaders: Record<string, string>;
  requestBody: Buffer;
}

interface GeneratedClaudeRetryAttempt extends ClaudeRetryAttempt {
  summary: string;
}

let cachedHttpsProxyAgentKey: string | null = null;
let cachedHttpsProxyAgent: HttpsAgent | null = null;

export interface CompactGateApp {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

export function createRequestLogger(configStore: ConfigStore): RequestLogger {
  return new RequestLogger(
    configStore.get().logging.keep_recent,
    resolveLogDatabasePath(configStore.getConfigPath())
  );
}

function createDebugCaptureWriter(): DebugCaptureWriter {
  return DebugCaptureWriter.fromEnv();
}

function createClaudeSummaryStore(configStore: ConfigStore): ClaudeSummaryStore {
  return new ClaudeSummaryStore(resolveClaudeSummaryDatabasePath(configStore.getConfigPath()));
}

interface StudioSseClient {
  keepAliveTimer: ReturnType<typeof setInterval>;
  res: ServerResponse;
}

class StudioEventBroadcaster {
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

export function createCompactGateApp(
  configStore: ConfigStore,
  logger = createRequestLogger(configStore),
  captureWriter = createDebugCaptureWriter(),
  compactionBridge = new CompactionBridgeStore(),
  claudeSummaryStore = createClaudeSummaryStore(configStore),
  studioEvents = new StudioEventBroadcaster()
): CompactGateApp {
  return {
    handler: (req, res) => {
      void routeRequest(
        req,
        res,
        configStore,
        logger,
        captureWriter,
        compactionBridge,
        claudeSummaryStore,
        studioEvents
      );
    }
  };
}

export function createCompactGateServer(
  configStore: ConfigStore,
  logger = createRequestLogger(configStore),
  captureWriter = createDebugCaptureWriter(),
  compactionBridge = new CompactionBridgeStore(),
  claudeSummaryStore = createClaudeSummaryStore(configStore),
  studioEvents = new StudioEventBroadcaster()
): http.Server {
  const app = createCompactGateApp(
    configStore,
    logger,
    captureWriter,
    compactionBridge,
    claudeSummaryStore,
    studioEvents
  );
  const server = http.createServer(app.handler);
  server.once("close", () => {
    logger.close();
    claudeSummaryStore.close();
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
  claudeSummaryStore: ClaudeSummaryStore,
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://compactgate.local");

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url, configStore, logger, studioEvents);
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
        claudeSummaryStore,
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
        studioEvents
      );
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, statusForError(error), { error: summaryForError(error) });
  }
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config/profiles") {
    const publicConfig = configStore.toPublicConfig();
    sendJson(res, 200, {
      profiles: publicConfig.profiles,
      active_profile_id: publicConfig.active_profile_id
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config/export") {
    sendJson(res, 200, configStore.get());
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config") {
    const patch = await readJsonBody(req);
    await configStore.patch(patch);
    logger.resize(configStore.get().logging.keep_recent);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    if (!isRecord(body) || typeof body.name !== "string") {
      throw new ConfigError("config profile save requires a name string.");
    }

    const profilePatch = Object.hasOwn(body, "config") ? body.config : {};
    await configStore.saveProfile(body.name, profilePatch);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "PATCH" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile update requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile update requires a profile id.");
    }

    const profilePatch = Object.hasOwn(body, "config") ? body.config : {};
    await configStore.updateProfile(
      profileId,
      typeof body.name === "string" ? body.name : undefined,
      profilePatch
    );
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/duplicate") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile duplicate requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile duplicate requires a profile id.");
    }

    await configStore.duplicateProfile(
      profileId,
      typeof body.name === "string" ? body.name : undefined
    );
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/config/profiles") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile delete requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile delete requires a profile id.");
    }

    await configStore.deleteProfile(profileId);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/profiles/apply") {
    const body = await readJsonBody(req);
    if (!isRecord(body)) {
      throw new ConfigError("config profile apply requires a profile id.");
    }

    const profileId = typeof body.profile_id === "string" ? body.profile_id : body.id;
    if (typeof profileId !== "string") {
      throw new ConfigError("config profile apply requires a profile id.");
    }

    await configStore.applyProfile(profileId);
    logger.resize(configStore.get().logging.keep_recent);
    studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
    sendJson(res, 200, configStore.toPublicConfig());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test-route") {
    const body = await readJsonBody(req);

    if (!isRecord(body) || typeof body.path !== "string") {
      throw new ConfigError("test-route requires a path string.");
    }

    const method = typeof body.method === "string" ? body.method.toUpperCase() : "POST";
    sendJson(
      res,
      200,
      previewRoute(method, body.path, body.body, configStore.get())
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, healthForConfig(configStore.get()));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs/recent") {
    const route = parseRouteFilter(url.searchParams.get("route"));
    const status = parseStatusFilter(url.searchParams.get("status"));
    const host = parseHostFilter(url.searchParams.get("host"));
    const limit = parsePositiveInteger(url.searchParams.get("limit"), configStore.get().logging.keep_recent);
    const offset = parseNonNegativeInteger(url.searchParams.get("offset"), 0);
    sendJson(res, 200, logger.page({ route, status, host, limit, offset }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    studioEvents.subscribe(req, res, createStudioSnapshot(configStore, logger));
    return;
  }

  sendJson(res, 404, { error: "API endpoint not found." });
}

async function proxyOpenAiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  compactionBridge: CompactionBridgeStore,
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  const startedAt = performance.now();
  const config = configStore.get();
  const route = routeForPath(url.pathname);
  const requestId = randomUUID();

  if (route === "compact") {
    await proxyCompactRequest(
      req,
      res,
      url,
      config,
      logger,
      captureWriter,
      compactionBridge,
      studioEvents,
      requestId,
      startedAt
    );
    return;
  }

  await proxyPrimaryRequest(
    req,
    res,
    url,
    config,
    logger,
    captureWriter,
    compactionBridge,
    studioEvents,
    requestId,
    startedAt
  );
}

async function proxyClaudeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  claudeSummaryStore: ClaudeSummaryStore,
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  const startedAt = performance.now();
  const config = configStore.get();
  const route: RouteKind = "claude";
  const requestId = randomUUID();
  const upstreamPath = stripAnthropicProxyPrefix(url.pathname);
  let upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
  let claudeRoute: ClaudeSubRoute = "primary";
  let responseClaudeRoute: ClaudeSubRoute = "primary";
  let retryReason: ClaudeRetryReason = "none";
  let requestHeaders: Record<string, string> = {};
  let upstreamBody: Buffer = Buffer.alloc(0);
  let status = 502;
  let errorSummary: string | null = null;
  let rawBody: Buffer = Buffer.alloc(0);
  let responseBody: Buffer = Buffer.alloc(0);
  let responseHeaders: IncomingHttpHeaders = {};
  let requestMetadata: RequestMetadata | null = null;
  let requestType: RequestTransport = "http";
  let firstTokenMs: number | null = null;
  let sourceModel: string | null = null;
  let usage: TokenUsageMetrics = emptyUsageMetrics();

  try {
    rawBody = await readRawBody(req, 100 * 1024 * 1024);
    requestMetadata = extractRequestMetadata(upstreamPath, rawBody);
    requestType = requestMetadata.requestType;
    sourceModel = extractSourceModel(rawBody);
    claudeRoute = "primary";
    upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
    upstreamBody = rawBody;
    const auth = resolveClaudeCredential(claudeRoute, config);
    requestHeaders = buildAnthropicUpstreamHeaders(req.headers, auth.apiKey);
    const canAutoCompactRetry =
      shouldConsiderClaudeAutoCompact(upstreamPath, rawBody);
    const summaryContext = canAutoCompactRetry
      ? buildClaudeSummaryContext(rawBody, sourceModel)
      : null;

    let finalResult: BufferedUpstreamResult | null = null;
    const cachedSummary =
      canAutoCompactRetry && summaryContext
        ? claudeSummaryStore.get(summaryContext.cacheKey) ??
          findCachedClaudePrefixSummary(claudeSummaryStore, rawBody, sourceModel)
        : null;

    if (cachedSummary) {
      retryReason = "reconnect";
      const retry = await retryClaudePrimaryWithSummary({
        req,
        res,
        config,
        upstreamPath,
        search: url.search,
        startedAt,
        originalBody: rawBody,
        summary: cachedSummary.summary,
        summarizedMessageCount: cachedSummary.messageCount
      });
      if (retry) {
        const retryResult = retry.result;
        finalResult = retryResult;
        upstream = retry.upstream;
        requestHeaders = retry.requestHeaders;
        upstreamBody = retry.requestBody;
        responseClaudeRoute = "primary";
        copyResponseHeaders(retryResult.responseHeaders, res);
        res.setHeader("x-compactgate-route", route);
        res.setHeader("x-compactgate-claude-route", responseClaudeRoute);
        res.setHeader("x-compactgate-claude-retry", "compacted");
        res.setHeader("x-compactgate-claude-retry-reason", retryReason);
        res.setHeader("x-compactgate-claude-summary", "cached");
        res.setHeader("x-compactgate-request-id", requestId);
        res.writeHead(retryResult.status);
        res.end(retryResult.responseBody);
      }
    }

    if (!finalResult && canAutoCompactRetry) {
      retryReason = "reconnect";
      const retry = await retryClaudeWithCompactSummary({
        req,
        res,
        config,
        upstreamPath,
        search: url.search,
        startedAt,
        originalBody: rawBody,
        sourceModel,
        originalErrorSummary: null,
        requestId
      });
      if (retry) {
        if (summaryContext) {
          claudeSummaryStore.put({
            ...summaryContext,
            summary: retry.summary
          });
        }
        const retryResult = retry.result;
        finalResult = retryResult;
        upstream = retry.upstream;
        requestHeaders = retry.requestHeaders;
        upstreamBody = retry.requestBody;
        responseClaudeRoute = "primary";
        copyResponseHeaders(retryResult.responseHeaders, res);
        res.setHeader("x-compactgate-route", route);
        res.setHeader("x-compactgate-claude-route", responseClaudeRoute);
        res.setHeader("x-compactgate-claude-retry", "compacted");
        res.setHeader("x-compactgate-claude-retry-reason", retryReason);
        res.setHeader("x-compactgate-claude-summary", "generated");
        res.setHeader("x-compactgate-request-id", requestId);
        res.writeHead(retryResult.status);
        res.end(retryResult.responseBody);
      }
    }

    if (!finalResult) {
      const result = await sendBufferedUpstreamRequest({
        req,
        res,
        upstream,
        startedAt,
        timeoutMs: config.timeouts.claude_ms,
        timeoutMessage: "Claude upstream request timed out.",
        requestHeaders,
        body: rawBody,
        extraResponseHeaders: {
          "x-compactgate-route": route,
          "x-compactgate-claude-route": claudeRoute,
          "x-compactgate-request-id": requestId
        },
        writeResponse: true
      });

      finalResult = result;
      status = result.status;
      errorSummary = result.errorSummary;
    }

    if (!finalResult) {
      throw new Error("Claude upstream request did not complete.");
    }

    let completedResult = finalResult;

    if (!res.headersSent) {
      responseClaudeRoute = claudeRoute;
      copyResponseHeaders(completedResult.responseHeaders, res);
      res.setHeader("x-compactgate-route", route);
      res.setHeader("x-compactgate-claude-route", responseClaudeRoute);
      res.setHeader("x-compactgate-request-id", requestId);
      res.writeHead(completedResult.status);
      res.end(completedResult.responseBody);
    }

    status = completedResult.status;
    errorSummary = completedResult.errorSummary;
    responseBody = completedResult.responseBody;
    responseHeaders = completedResult.responseHeaders;
    requestType = responseTransport(responseHeaders) ?? requestType;
    firstTokenMs = completedResult.firstTokenMs;
    usage = extractResponseUsage(responseBody, responseHeaders);
  } catch (error) {
    status = 502;
    errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendJson(res, status, { error: errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(errorSummary));
    }
  } finally {
    const logUrl = new URL(`${upstreamPath}${url.search}`, "http://compactgate.local");
    const logEntry = addLog(logger, {
      route,
      req,
      url: logUrl,
      status,
      startedAt,
      endpoint: requestMetadata?.endpoint ?? endpointFromPath(upstreamPath),
      requestType,
      reasoningEffort: requestMetadata?.reasoningEffort ?? null,
      requestSummary: requestMetadata?.requestSummary ?? null,
      upstreamHost: upstream.host,
      requestId,
      sourceModel,
      targetModel: sourceModel,
      firstTokenMs,
      usage,
      errorSummary
    });
    studioEvents.broadcastLog(logEntry);

    await persistCapture(captureWriter, {
      request_id: requestId,
      time: new Date().toISOString(),
      route,
      method: req.method ?? "GET",
      path: `${upstreamPath}${url.search}`,
      upstream_url: upstream.toString(),
      upstream_host: upstream.host,
      source_model: sourceModel,
      target_model: sourceModel,
      compact_bridge_replacements: 0,
      incoming_request: {
        headers: serializeHeaders(req.headers),
        body: serializeBody(rawBody)
      },
      upstream_request: {
        headers: serializeHeaders(requestHeaders),
        body: serializeBody(upstreamBody.byteLength > 0 ? upstreamBody : rawBody)
      },
      upstream_response: {
        status,
        headers: serializeHeaders(responseHeaders),
        body: serializeBody(responseBody)
      }
    });
  }
}

async function proxyPrimaryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CompactGateConfig,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  compactionBridge: CompactionBridgeStore,
  studioEvents: StudioEventBroadcaster,
  requestId: string,
  startedAt: number
): Promise<void> {
  const route: RouteKind = "primary";
  const upstream = buildUpstreamUrl(config.primary.base_url, url.pathname, url.search);
  const auth = resolveRouteCredential("primary", config);
  let requestHeaders: Record<string, string> = {};
  let status = 502;
  let errorSummary: string | null = null;
  let rawBody: Buffer = Buffer.alloc(0);
  let upstreamBody: Buffer = Buffer.alloc(0);
  let responseBody: Buffer = Buffer.alloc(0);
  let responseHeaders: IncomingHttpHeaders = {};
  let sourceModel: string | null = null;
  let compactBridgeReplacements = 0;
  let requestMetadata: RequestMetadata | null = null;
  let requestType: RequestTransport = "http";
  let firstTokenMs: number | null = null;
  let usage: TokenUsageMetrics = emptyUsageMetrics();

  try {
    rawBody = await readRawBody(req);
    requestMetadata = extractRequestMetadata(url.pathname, rawBody);
    requestType = requestMetadata.requestType;
    sourceModel = extractJsonModel(rawBody).sourceModel;

    const bridgeResult =
      config.compact.upstream_mode === "split"
        ? compactionBridge.rewritePrimaryBody(rawBody)
        : { body: rawBody, replacedCompactionCount: 0 };
    upstreamBody = bridgeResult.body;
    compactBridgeReplacements = bridgeResult.replacedCompactionCount;
    requestHeaders = buildUpstreamHeaders(req.headers, auth.apiKey);

    const result = await sendOpenAiUpstreamRequest({
      req,
      res,
      upstream,
      startedAt,
      timeoutMs: config.timeouts.primary_ms,
      timeoutMessage: "Primary upstream request timed out.",
      requestHeaders,
      body: upstreamBody,
      extraResponseHeaders: {
        "x-compactgate-route": route,
        "x-compactgate-request-id": requestId
      },
      retryEmptyStreamError: requestType === "stream"
    });

    status = result.status;
    errorSummary = result.errorSummary;
    responseBody = result.responseBody;
    responseHeaders = result.responseHeaders;
    requestType = responseTransport(responseHeaders) ?? requestType;
    firstTokenMs = result.firstTokenMs;
    usage = extractResponseUsage(responseBody, responseHeaders);
  } catch (error) {
    status = 502;
    errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendJson(res, status, { error: errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(errorSummary));
    }
  } finally {
    const logEntry = addLog(logger, {
      route,
      req,
      url,
      status,
      startedAt,
      endpoint: requestMetadata?.endpoint ?? endpointFromPath(url.pathname),
      requestType,
      reasoningEffort: requestMetadata?.reasoningEffort ?? null,
      requestSummary: requestMetadata?.requestSummary ?? null,
      upstreamHost: upstream.host,
      requestId,
      sourceModel,
      targetModel: sourceModel,
      firstTokenMs,
      usage,
      errorSummary
    });
    studioEvents.broadcastLog(logEntry);

    await persistCapture(captureWriter, {
      request_id: requestId,
      time: new Date().toISOString(),
      route,
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      upstream_url: upstream.toString(),
      upstream_host: upstream.host,
      source_model: sourceModel,
      target_model: sourceModel,
      compact_bridge_replacements: compactBridgeReplacements,
      incoming_request: {
        headers: serializeHeaders(req.headers),
        body: serializeBody(rawBody)
      },
      upstream_request: {
        headers: serializeHeaders(requestHeaders),
        body: serializeBody(upstreamBody)
      },
      upstream_response: {
        status,
        headers: serializeHeaders(responseHeaders),
        body: serializeBody(responseBody)
      }
    });
  }
}

async function proxyCompactRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CompactGateConfig,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  compactionBridge: CompactionBridgeStore,
  studioEvents: StudioEventBroadcaster,
  requestId: string,
  startedAt: number
): Promise<void> {
  const route: RouteKind = "compact";
  const upstream = buildUpstreamUrl(compactUpstreamBaseUrl(config), url.pathname, url.search);
  const auth = resolveRouteCredential("compact", config);
  let sourceModel: string | null = null;
  let targetModel: string | null = null;
  let status = 502;
  let errorSummary: string | null = null;
  let rawBody: Buffer | null = null;
  let upstreamBody: Buffer = Buffer.alloc(0);
  let responseBody: Buffer = Buffer.alloc(0);
  let responseHeaders: IncomingHttpHeaders = {};
  let requestHeaders: Record<string, string> = {};
  let attemptedUpstream = false;
  let requestMetadata: RequestMetadata | null = null;
  let requestType: RequestTransport = "http";
  let firstTokenMs: number | null = null;
  let usage: TokenUsageMetrics = emptyUsageMetrics();

  try {
    rawBody = await readRawBody(req);
    requestMetadata = extractRequestMetadata(url.pathname, rawBody);
    requestType = requestMetadata.requestType;
    const rewrite = rewriteCompactBody(rawBody, config);
    sourceModel = rewrite.sourceModel;
    targetModel = rewrite.targetModel;
    upstreamBody = rewrite.body;
    attemptedUpstream = true;
    requestHeaders = buildUpstreamHeaders(req.headers, auth.apiKey);

    const result = await sendOpenAiUpstreamRequest({
      req,
      res,
      upstream,
      startedAt,
      timeoutMs: config.timeouts.compact_ms,
      timeoutMessage: "Compact upstream request timed out.",
      requestHeaders,
      body: upstreamBody,
      extraResponseHeaders: {
        "x-compactgate-route": route,
        "x-compactgate-model": targetModel ?? "",
        "x-compactgate-request-id": requestId
      },
      retryEmptyStreamError: requestType === "stream"
    });

    status = result.status;
    errorSummary = result.errorSummary;
    responseBody = result.responseBody;
    responseHeaders = result.responseHeaders;
    requestType = responseTransport(responseHeaders) ?? requestType;
    firstTokenMs = result.firstTokenMs;
    usage = extractResponseUsage(responseBody, responseHeaders);
    if (status >= 200 && status < 300) {
      compactionBridge.storeCompactResponse(responseBody);
    }
  } catch (error) {
    status = attemptedUpstream ? 502 : 400;
    errorSummary = summaryForError(error);

    if (!sourceModel && rawBody) {
      sourceModel = extractJsonModel(rawBody).sourceModel;
    }

    if (!res.headersSent) {
      sendJson(res, status, { error: errorSummary, request_id: requestId });
    }
  } finally {
    const logEntry = addLog(logger, {
      route,
      req,
      url,
      status,
      startedAt,
      endpoint: requestMetadata?.endpoint ?? endpointFromPath(url.pathname),
      requestType,
      reasoningEffort: requestMetadata?.reasoningEffort ?? null,
      requestSummary: requestMetadata?.requestSummary ?? null,
      upstreamHost: upstream.host,
      requestId,
      sourceModel,
      targetModel,
      firstTokenMs,
      usage,
      errorSummary
    });
    studioEvents.broadcastLog(logEntry);

    await persistCapture(captureWriter, {
      request_id: requestId,
      time: new Date().toISOString(),
      route,
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      upstream_url: upstream.toString(),
      upstream_host: upstream.host,
      source_model: sourceModel,
      target_model: targetModel,
      compact_bridge_replacements: 0,
      incoming_request: {
        headers: serializeHeaders(req.headers),
        body: serializeBody(rawBody ?? Buffer.alloc(0))
      },
      upstream_request: {
        headers: serializeHeaders(requestHeaders),
        body: serializeBody(upstreamBody)
      },
      upstream_response: {
        status,
        headers: serializeHeaders(responseHeaders),
        body: serializeBody(responseBody)
      }
    });
  }
}

interface BufferedUpstreamOptions {
  req: IncomingMessage;
  res: ServerResponse;
  upstream: URL;
  startedAt: number;
  timeoutMs: number;
  timeoutMessage: string;
  requestHeaders: Record<string, string>;
  body: Buffer;
  extraResponseHeaders: Record<string, string>;
  writeResponse?: boolean;
  deferRetryableStreamErrors?: boolean;
}

interface BufferedUpstreamResult {
  status: number;
  errorSummary: string | null;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
}

interface OpenAiUpstreamOptions extends BufferedUpstreamOptions {
  retryEmptyStreamError?: boolean;
}

function sendBufferedUpstreamRequest(
  options: BufferedUpstreamOptions
): Promise<BufferedUpstreamResult> {
  const client = options.upstream.protocol === "https:" ? https : http;
  const headers = { ...options.requestHeaders };
  headers["content-length"] = String(options.body.byteLength);
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  delete headers["transfer-encoding"];

  return new Promise((resolve, reject) => {
    let settled = false;
    let upstreamReq: http.ClientRequest | null = null;
    let upstreamRes: IncomingMessage | null = null;

    const cleanup = () => {
      options.res.off("close", handleClientClose);
      options.res.off("error", handleClientError);
      upstreamReq?.off("timeout", handleTimeout);
    };

    const resolveOnce = (result: BufferedUpstreamResult) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const clientDisconnectError = () =>
      new Error("Client disconnected before upstream response completed.");

    function handleClientClose() {
      if (options.res.writableEnded || settled) {
        return;
      }

      const error = clientDisconnectError();
      upstreamReq?.destroy();
      rejectOnce(error);
    }

    function handleClientError(error: Error) {
      upstreamReq?.destroy();
      rejectOnce(error);
    }

    function handleTimeout() {
      upstreamReq?.destroy(new Error(options.timeoutMessage));
    }

    function handleUpstreamRequestError(error: Error) {
      rejectOnce(error);
    }

    function handleUpstreamResponseAborted() {
      rejectOnce(new Error("Upstream response aborted before completion."));
    }

    function handleUpstreamResponseError(error: Error) {
      rejectOnce(error);
    }

    const requestOptions: RequestOptions = {
      method: options.req.method,
      headers,
      timeout: options.timeoutMs
    };
    const agent = resolveUpstreamAgent(options.upstream);
    if (agent) {
      requestOptions.agent = agent;
    }

    upstreamReq = client.request(
      options.upstream,
      requestOptions,
      (response) => {
        upstreamRes = response;
        const status = response.statusCode ?? 502;
        const responseChunks: Buffer[] = [];
        let firstTokenMs: number | null = null;
        const shouldWriteResponse =
          options.writeResponse !== false &&
          !(options.deferRetryableStreamErrors === true && status >= 500);
        if (shouldWriteResponse) {
          copyResponseHeaders(response.headers, options.res);
          for (const [name, value] of Object.entries(options.extraResponseHeaders)) {
            options.res.setHeader(name, value);
          }
          options.res.writeHead(status);
        }
        response.on("data", (chunk: Buffer) => {
          firstTokenMs ??= Math.max(0, Math.round(performance.now() - options.startedAt));
          responseChunks.push(Buffer.from(chunk));
        });
        response.on("aborted", handleUpstreamResponseAborted);
        response.on("error", handleUpstreamResponseError);
        if (shouldWriteResponse) {
          response.pipe(options.res);
        }

        response.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          resolveOnce({
            status,
            errorSummary: extractResponseErrorSummary(status, responseBody, response.headers),
            responseBody,
            responseHeaders: response.headers,
            firstTokenMs
          });
        });
      }
    );

    options.res.once("close", handleClientClose);
    options.res.once("error", handleClientError);
    upstreamReq.once("timeout", handleTimeout);
    upstreamReq.once("error", handleUpstreamRequestError);

    upstreamReq.end(options.body);
  });
}

async function sendOpenAiUpstreamRequest(
  options: OpenAiUpstreamOptions
): Promise<BufferedUpstreamResult> {
  if (options.retryEmptyStreamError !== true) {
    return sendBufferedUpstreamRequest(options);
  }

  const firstResult = await sendBufferedUpstreamRequest({
    ...options,
    deferRetryableStreamErrors: true
  });

  if (!isRetryableEmptyStreamUpstreamError(firstResult)) {
    writeDeferredUpstreamResult(options.res, firstResult, options.extraResponseHeaders);
    return firstResult;
  }

  const retryResult = await sendBufferedUpstreamRequest(options);
  if (retryResult.errorSummary) {
    retryResult.errorSummary = `${retryResult.errorSummary} (retried after empty upstream stream)`;
  }

  return retryResult;
}

function isRetryableEmptyStreamUpstreamError(result: BufferedUpstreamResult): boolean {
  if (result.status < 500) {
    return false;
  }

  const text = decodeBodyText(result.responseBody).toLowerCase();
  return (
    text.includes("upstream_stream_error") ||
    text.includes("stream disconnected before valid content") ||
    (text.includes("received 0 chars") && text.includes("content is insufficient"))
  );
}

function decodeBodyText(body: Buffer): string {
  if (body.byteLength === 0) {
    return "";
  }

  if (!looksLikeGzip(body)) {
    return body.toString("utf8");
  }

  try {
    return gunzipSync(body).toString("utf8");
  } catch {
    return "";
  }
}

function writeDeferredUpstreamResult(
  res: ServerResponse,
  result: BufferedUpstreamResult,
  extraResponseHeaders: Record<string, string>
): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  copyResponseHeaders(result.responseHeaders, res);
  for (const [name, value] of Object.entries(extraResponseHeaders)) {
    res.setHeader(name, value);
  }
  res.writeHead(result.status);
  res.end(result.responseBody);
}

class HttpConnectHttpsAgent extends HttpsAgent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: RequestOptions & { servername?: string },
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const targetHost = String(options.hostname ?? options.host ?? "");
    const targetPort = Number(options.port ?? 443);
    const proxyHost = this.proxy.hostname;
    const proxyPort = Number(this.proxy.port || 80);
    const proxySocket = net.connect(proxyPort, proxyHost);
    const complete = callback ?? (() => undefined);
    let responseBuffer = Buffer.alloc(0);
    let completed = false;

    const cleanup = () => {
      proxySocket.off("connect", handleConnect);
      proxySocket.off("data", handleData);
      proxySocket.off("error", handleProxyError);
    };

    const fail = (error: Error) => {
      if (completed) {
        return;
      }

      completed = true;
      cleanup();
      proxySocket.destroy();
      complete(error, proxySocket);
    };

    const succeed = (socket: tls.TLSSocket) => {
      if (completed) {
        return;
      }

      completed = true;
      cleanup();
      complete(null, socket);
    };

    const handleConnect = () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        "Proxy-Connection: Keep-Alive"
      ];
      const auth = proxyAuthorizationHeader(this.proxy);
      if (auth) {
        lines.push(`Proxy-Authorization: ${auth}`);
      }

      proxySocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    };

    const handleData = (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const rawHeader = responseBuffer.subarray(0, headerEnd).toString("latin1");
      const statusLine = rawHeader.split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        fail(new Error(`Proxy CONNECT failed: ${statusLine || "no status line"}`));
        return;
      }

      const remaining = responseBuffer.subarray(headerEnd + 4);
      if (remaining.byteLength > 0) {
        proxySocket.unshift(remaining);
      }

      proxySocket.off("data", handleData);
      proxySocket.off("error", handleProxyError);

      const tlsSocket = tls.connect(
        {
          socket: proxySocket,
          servername: typeof options.servername === "string" ? options.servername : targetHost,
          ALPNProtocols: ["http/1.1"]
        },
        () => succeed(tlsSocket)
      );
      tlsSocket.once("error", fail);
    };

    const handleProxyError = (error: Error) => {
      fail(error);
    };

    proxySocket.once("connect", handleConnect);
    proxySocket.on("data", handleData);
    proxySocket.once("error", handleProxyError);

    return undefined;
  }
}

function resolveUpstreamAgent(upstream: URL): HttpAgent | HttpsAgent | undefined {
  if (upstream.protocol !== "https:") {
    return undefined;
  }

  const proxy = resolveHttpsProxy(upstream);
  if (!proxy) {
    return undefined;
  }

  const key = proxy.toString();
  if (cachedHttpsProxyAgentKey !== key || !cachedHttpsProxyAgent) {
    cachedHttpsProxyAgentKey = key;
    cachedHttpsProxyAgent = new HttpConnectHttpsAgent(proxy);
  }

  return cachedHttpsProxyAgent ?? undefined;
}

function resolveHttpsProxy(upstream: URL): URL | null {
  const configured =
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim();
  if (!configured || hostMatchesNoProxy(upstream)) {
    return null;
  }

  try {
    const proxy = new URL(configured);
    return proxy.protocol === "http:" ? proxy : null;
  } catch {
    return null;
  }
}

function hostMatchesNoProxy(upstream: URL): boolean {
  const configured = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const host = upstream.hostname.toLowerCase();
  const port = upstream.port || (upstream.protocol === "https:" ? "443" : "80");

  for (const rawPattern of configured.split(",")) {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) {
      continue;
    }

    if (pattern === "*") {
      return true;
    }

    const [patternHost, patternPort] = splitNoProxyPattern(pattern);
    if (patternPort && patternPort !== port) {
      continue;
    }

    if (patternHost.startsWith(".")) {
      const suffix = patternHost.slice(1);
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        return true;
      }
      continue;
    }

    if (host === patternHost || host.endsWith(`.${patternHost}`)) {
      return true;
    }
  }

  return false;
}

function splitNoProxyPattern(pattern: string): [host: string, port: string | null] {
  const index = pattern.lastIndexOf(":");
  if (index <= 0 || pattern.includes("]")) {
    return [pattern, null];
  }

  const possiblePort = pattern.slice(index + 1);
  if (!/^\d+$/.test(possiblePort)) {
    return [pattern, null];
  }

  return [pattern.slice(0, index), possiblePort];
}

function proxyAuthorizationHeader(proxy: URL): string | null {
  if (!proxy.username && !proxy.password) {
    return null;
  }

  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null
): Record<string, string> {
  const next: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === "host") {
      continue;
    }

    if (typeof value === "string") {
      next[lowerName] = value;
    } else if (Array.isArray(value)) {
      next[lowerName] = value.join(", ");
    }
  }

  if (apiKey) {
    next.authorization = `Bearer ${apiKey}`;
  }

  return next;
}

function buildAnthropicUpstreamHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null
): Record<string, string> {
  const next = buildUpstreamHeaders(headers, null);

  if (apiKey) {
    next.authorization = `Bearer ${apiKey}`;
    next["x-api-key"] = apiKey;
    next["anthropic-api-key"] = apiKey;
  }

  return next;
}

function copyResponseHeaders(headers: IncomingHttpHeaders, res: ServerResponse): void {
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) {
      continue;
    }

    res.setHeader(name, value);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const rawBody = await readRawBody(req);
  if (rawBody.byteLength === 0) {
    return {};
  }

  return JSON.parse(rawBody.toString("utf8")) as unknown;
}

function readRawBody(req: IncomingMessage, limitBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function addLog(
  logger: RequestLogger,
  input: {
    route: RouteKind;
    req: IncomingMessage;
    url: URL;
    status: number;
    startedAt: number;
    endpoint: string;
    requestType: RequestTransport;
    reasoningEffort: string | null;
    requestSummary: string | null;
    upstreamHost: string;
    requestId: string;
    sourceModel: string | null;
    targetModel: string | null;
    firstTokenMs: number | null;
    usage: TokenUsageMetrics;
    errorSummary: string | null;
  }
): RequestLogEntry {
  const entry: RequestLogEntry = {
    time: new Date().toISOString(),
    route: input.route,
    method: input.req.method ?? "GET",
    path: `${input.url.pathname}${input.url.search}`,
    endpoint: input.endpoint,
    request_type: input.requestType,
    reasoning_effort: input.reasoningEffort,
    request_summary: input.requestSummary,
    source_model: input.sourceModel,
    target_model: input.targetModel,
    status: input.status,
    duration_ms: Math.max(0, Math.round(performance.now() - input.startedAt)),
    first_token_ms: input.firstTokenMs,
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    cached_input_tokens: input.usage.cachedInputTokens,
    cached_output_tokens: input.usage.cachedOutputTokens,
    total_tokens: input.usage.totalTokens,
    upstream_host: input.upstreamHost,
    user_agent: readHeaderString(input.req.headers["user-agent"]),
    request_id: input.requestId,
    error_summary: input.errorSummary
  };
  logger.add(entry);
  return entry;
}

function readHeaderString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const joined = value.join(", ").trim();
    return joined.length > 0 ? joined : null;
  }

  const text = value?.trim();
  return text && text.length > 0 ? text : null;
}

function emptyUsageMetrics(): TokenUsageMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cachedOutputTokens: null,
    totalTokens: null
  };
}

function endpointFromPath(pathname: string): string {
  if (pathname === "/v1") {
    return "/";
  }

  if (pathname.startsWith("/v1/")) {
    return pathname.slice(3);
  }

  return pathname || "/";
}

function isAnthropicProxyPath(pathname: string): boolean {
  return pathname === ANTHROPIC_PROXY_PREFIX || pathname.startsWith(`${ANTHROPIC_PROXY_PREFIX}/`);
}

function stripAnthropicProxyPrefix(pathname: string): string {
  const stripped = pathname.slice(ANTHROPIC_PROXY_PREFIX.length);
  return stripped.length > 0 ? stripped : "/";
}

function buildClaudeUpstreamUrl(baseUrl: string, requestPath: string, search = ""): URL {
  const base = new URL(baseUrl);
  const cleanBasePath = base.pathname.replace(/\/+$/, "");
  const cleanRequestPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;

  base.pathname = `${cleanBasePath}${cleanRequestPath}`.replace(/\/{2,}/g, "/");
  base.search = search;
  return base;
}

function resolveClaudeCredential(route: ClaudeSubRoute, config: CompactGateConfig) {
  return resolveRouteCredential(route === "compact" ? "claude_compact" : "claude_primary", config);
}

function claudeCompactUpstreamBaseUrl(config: CompactGateConfig): string {
  return config.claude.compact.upstream_mode === "primary"
    ? config.claude.primary.base_url
    : config.claude.compact.base_url;
}

function shouldConsiderClaudeAutoCompact(requestPath: string, rawBody: Buffer): boolean {
  const endpoint = endpointFromPath(requestPath);
  if (endpoint !== "/messages") {
    return false;
  }

  const parsed = parseJsonRecord(rawBody);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return false;
  }

  const reconnectCount = readClaudeReconnectCount(parsed);
  return reconnectCount !== null && reconnectCount >= CLAUDE_RECONNECT_AUTO_COMPACT_MIN_COUNT;
}

function readClaudeReconnectCount(value: unknown, depth = 0): number | null {
  if (depth > 8) {
    return null;
  }

  if (Array.isArray(value)) {
    return maxNumbers(value.map((item) => readClaudeReconnectCount(item, depth + 1)));
  }

  if (!isRecord(value)) {
    return null;
  }

  const direct = readNumericReconnectCount(value.reconnect_count);
  const nested = Object.entries(value)
    .filter(([key]) => key !== "content" && key !== "text")
    .map(([, child]) => readClaudeReconnectCount(child, depth + 1));

  return maxNumbers([direct, ...nested]);
}

function readNumericReconnectCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    return null;
  }

  return Number.parseInt(value.trim(), 10);
}

function maxNumbers(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function buildClaudeSummaryContext(
  rawBody: Buffer,
  sourceModel: string | null,
  messageLimit?: number
): ClaudeSummaryContext | null {
  const parsed = parseJsonRecord(rawBody);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return null;
  }

  const messages = typeof messageLimit === "number"
    ? parsed.messages.slice(0, messageLimit)
    : parsed.messages;
  if (messages.length === 0) {
    return null;
  }

  const model = readStringField(parsed.model) ?? sourceModel;
  const context = {
    version: 1,
    model,
    system: parsed.system ?? null,
    messages,
    tools: parsed.tools ?? null,
    tool_choice: parsed.tool_choice ?? null
  };
  const digest = createHash("sha256")
    .update(stableJsonStringify(context))
    .digest("hex");

  return {
    cacheKey: `claude-summary-v1:${digest}`,
    messageCount: messages.length,
    sourceModel: model
  };
}

function findCachedClaudePrefixSummary(
  claudeSummaryStore: ClaudeSummaryStore,
  rawBody: Buffer,
  sourceModel: string | null
): ClaudeSummaryRecord | null {
  const parsed = parseJsonRecord(rawBody);
  if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length < 2) {
    return null;
  }

  for (let count = parsed.messages.length - 1; count >= 1; count -= 1) {
    const prefixContext = buildClaudeSummaryContext(rawBody, sourceModel, count);
    if (!prefixContext) {
      continue;
    }

    const cached = claudeSummaryStore.get(prefixContext.cacheKey);
    if (cached) {
      return cached;
    }
  }

  return null;
}

async function retryClaudePrimaryWithSummary({
  req,
  res,
  config,
  upstreamPath,
  search,
  startedAt,
  originalBody,
  summary,
  summarizedMessageCount
}: {
  req: IncomingMessage;
  res: ServerResponse;
  config: CompactGateConfig;
  upstreamPath: string;
  search: string;
  startedAt: number;
  originalBody: Buffer;
  summary: string;
  summarizedMessageCount?: number;
}): Promise<ClaudeRetryAttempt | null> {
  const retryBody = buildClaudeRetryBody(originalBody, summary, summarizedMessageCount);
  if (!retryBody) {
    return null;
  }

  const primaryUpstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, search);
  const primaryHeaders = buildAnthropicUpstreamHeaders(
    req.headers,
    resolveClaudeCredential("primary", config).apiKey
  );
  const retryResult = await sendBufferedUpstreamRequest({
    req,
    res,
    upstream: primaryUpstream,
    startedAt,
    timeoutMs: config.timeouts.claude_ms,
    timeoutMessage: "Claude primary retry request timed out.",
    requestHeaders: primaryHeaders,
    body: retryBody,
    extraResponseHeaders: {},
    writeResponse: false
  });

  return {
    result: retryResult,
    upstream: primaryUpstream,
    requestHeaders: primaryHeaders,
    requestBody: retryBody
  };
}

async function retryClaudeWithCompactSummary({
  req,
  res,
  config,
  upstreamPath,
  search,
  startedAt,
  originalBody,
  sourceModel,
  originalErrorSummary,
  requestId
}: {
  req: IncomingMessage;
  res: ServerResponse;
  config: CompactGateConfig;
  upstreamPath: string;
  search: string;
  startedAt: number;
  originalBody: Buffer;
  sourceModel: string | null;
  originalErrorSummary: string | null;
  requestId: string;
}): Promise<GeneratedClaudeRetryAttempt | null> {
  const compactBody = buildClaudeAutoCompactBody(
    originalBody,
    sourceModel,
    originalErrorSummary,
    config.claude.compact.model_override
  );
  if (!compactBody) {
    return null;
  }

  const compactUpstream = buildClaudeUpstreamUrl(claudeCompactUpstreamBaseUrl(config), upstreamPath, search);
  const compactHeaders = buildAnthropicUpstreamHeaders(
    req.headers,
    resolveClaudeCredential("compact", config).apiKey
  );
  const compactResult = await sendBufferedUpstreamRequest({
    req,
    res,
    upstream: compactUpstream,
    startedAt,
    timeoutMs: config.timeouts.claude_ms,
    timeoutMessage: "Claude compact retry request timed out.",
    requestHeaders: compactHeaders,
    body: compactBody,
    extraResponseHeaders: {},
    writeResponse: false
  });

  if (compactResult.status >= 400) {
    return null;
  }

  const summary = extractClaudeSummaryText(compactResult.responseBody);
  if (!summary) {
    return null;
  }

  const retry = await retryClaudePrimaryWithSummary({
    req,
    res,
    config,
    upstreamPath,
    search,
    startedAt,
    originalBody,
    summary
  });
  if (!retry) {
    return null;
  }

  return {
    ...retry,
    summary
  };
}

function buildClaudeAutoCompactBody(
  originalBody: Buffer,
  sourceModel: string | null,
  originalErrorSummary: string | null,
  compactModelOverride: string
): Buffer | null {
  const parsed = parseJsonRecord(originalBody);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return null;
  }

  const transcript = stringifyForClaudeSummary(parsed.messages);
  const system = stringifyForClaudeSummary(parsed.system);
  const model = readStringField(compactModelOverride) ?? sourceModel ?? readStringField(parsed.model) ?? "claude";
  const prompt = [
    "Your task is to create a detailed summary of the conversation so far.",
    "CRITICAL: Respond with TEXT ONLY.",
    "The proxy will use your response as replacement context for a retry to the primary Claude route.",
    originalErrorSummary ? `Primary route error before compaction: ${originalErrorSummary}` : "",
    system ? `<system>\n${system}\n</system>` : "",
    `<conversation>\n${transcript}\n</conversation>`,
    "<summary>"
  ].filter((line) => line.length > 0).join("\n\n");

  return Buffer.from(JSON.stringify({
    model,
    max_tokens: CLAUDE_AUTO_COMPACT_SUMMARY_TOKENS,
    messages: [{ role: "user", content: prompt }]
  }));
}

function buildClaudeRetryBody(
  originalBody: Buffer,
  summary: string,
  summarizedMessageCount?: number
): Buffer | null {
  const parsed = parseJsonRecord(originalBody);
  if (!parsed) {
    return null;
  }

  const originalMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const preservedTail = typeof summarizedMessageCount === "number"
    ? originalMessages.slice(Math.max(0, summarizedMessageCount))
    : [];

  const retryBody = {
    ...parsed,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Continue from this compacted conversation summary.",
              "",
              summary
            ].join("\n")
          }
        ]
      },
      ...preservedTail
    ]
  };

  return Buffer.from(JSON.stringify(retryBody));
}

function extractClaudeSummaryText(responseBody: Buffer): string | null {
  const parsed = parseJsonRecord(responseBody);
  if (!parsed) {
    return null;
  }

  const text = extractClaudeResponseTextContent(parsed.content);
  return text.trim().length > 0 ? text.trim() : null;
}

function stringifyForClaudeSummary(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractClaudeResponseTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }

      if (typeof item.text === "string") {
        return item.text;
      }

      return typeof item.thinking === "string" ? item.thinking : "";
    })
    .filter((item) => item.length > 0)
    .join("\n");
}

async function persistCapture(
  captureWriter: DebugCaptureWriter,
  record: CaptureRecord
): Promise<void> {
  if (!captureWriter.isEnabled()) {
    return;
  }

  await captureWriter.write(record);
}

function healthForConfig(config: CompactGateConfig): HealthResponse {
  const primaryCredential = resolveRouteCredential("primary", config);
  const compactCredential = resolveRouteCredential("compact", config);
  const claudePrimaryCredential = resolveRouteCredential("claude_primary", config);
  const claudeCompactCredential = resolveRouteCredential("claude_compact", config);

  return {
    status: "ok",
    time: new Date().toISOString(),
    listen: config.listen,
    primary: {
      status: statusForBaseUrl(config.primary.base_url),
      base_url: config.primary.base_url,
      host: hostOrNull(config.primary.base_url),
      api_key_env: config.primary.api_key_env,
      stored_api_key: config.primary.api_key.trim().length > 0,
      api_key_configured: primaryCredential.apiKeyConfigured,
      api_key_source: primaryCredential.apiKeySource,
      active_api_key_env: primaryCredential.activeApiKeyEnv,
      active_credential_scope: primaryCredential.activeCredentialScope
    },
    compact: {
      status: statusForBaseUrl(config.compact.base_url),
      base_url: config.compact.base_url,
      host: hostOrNull(config.compact.base_url),
      api_key_env: config.compact.api_key_env,
      stored_api_key: config.compact.api_key.trim().length > 0,
      api_key_configured: compactCredential.apiKeyConfigured,
      api_key_source: compactCredential.apiKeySource,
      active_api_key_env: compactCredential.activeApiKeyEnv,
      active_credential_scope: compactCredential.activeCredentialScope
    },
    claude: {
      primary: {
        status: statusForBaseUrl(config.claude.primary.base_url),
        base_url: config.claude.primary.base_url,
        host: hostOrNull(config.claude.primary.base_url),
        api_key_env: config.claude.primary.api_key_env,
        stored_api_key: config.claude.primary.api_key.trim().length > 0,
        api_key_configured: claudePrimaryCredential.apiKeyConfigured,
        api_key_source: claudePrimaryCredential.apiKeySource,
        active_api_key_env: claudePrimaryCredential.activeApiKeyEnv,
        active_credential_scope: claudePrimaryCredential.activeCredentialScope
      },
      compact: {
        status: statusForBaseUrl(config.claude.compact.base_url),
        base_url: config.claude.compact.base_url,
        host: hostOrNull(config.claude.compact.base_url),
        api_key_env: config.claude.compact.api_key_env,
        stored_api_key: config.claude.compact.api_key.trim().length > 0,
        api_key_configured: claudeCompactCredential.apiKeyConfigured,
        api_key_source: claudeCompactCredential.apiKeySource,
        active_api_key_env: claudeCompactCredential.activeApiKeyEnv,
        active_credential_scope: claudeCompactCredential.activeCredentialScope
      }
    }
  };
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const publicDir = resolvePublicDir();
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safeRelativePath = requested.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, safeRelativePath);
  const fallbackPath = path.resolve(publicDir, "index.html");
  const targetPath = filePath.startsWith(publicDir) && existsSync(filePath) ? filePath : fallbackPath;

  if (!existsSync(targetPath)) {
    sendJson(res, 200, {
      name: "CompactGate",
      message: "Build the Studio UI with npm run build, or run Vite during development."
    });
    return;
  }

  const stat = statSync(targetPath);
  if (!stat.isFile()) {
    sendJson(res, 404, { error: "File not found." });
    return;
  }

  res.statusCode = 200;
  res.setHeader(
    "content-type",
    STATIC_MIME_TYPES[path.extname(targetPath)] ?? "application/octet-stream"
  );
  res.setHeader("content-length", String(stat.size));

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(targetPath).pipe(res);
}

function createStudioSnapshot(
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

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.byteLength));
  res.end(body);
}

function statusForError(error: unknown): number {
  if (error instanceof ConfigError) {
    return 400;
  }

  if (error instanceof SyntaxError) {
    return 400;
  }

  return 500;
}

function summaryForError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function parseRouteFilter(value: string | null): RouteKind | undefined {
  if (value === "primary" || value === "compact" || value === "claude") {
    return value;
  }

  return undefined;
}

function parseStatusFilter(value: string | null): LogStatusKind | undefined {
  return value === "normal" || value === "error" ? value : undefined;
}

function parseHostFilter(value: string | null): string | undefined {
  const host = value?.trim();
  return host && host.length > 0 ? host : undefined;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, 2_000);
}

function parseNonNegativeInteger(value: string | null, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function statusForBaseUrl(value: string): "configured" | "invalid" {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? "configured" : "invalid";
  } catch {
    return "invalid";
  }
}

function hostOrNull(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function parseJsonRecord(buffer: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    if (!looksLikeGzip(buffer)) {
      return null;
    }

    try {
      const parsed = JSON.parse(gunzipSync(buffer).toString("utf8")) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) {
      sorted[key] = sortJsonValue(child);
    }
  }
  return sorted;
}

function looksLikeGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function resolvePublicDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "../public"),
    path.resolve(process.cwd(), "dist/public"),
    path.resolve(process.cwd(), "public")
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
