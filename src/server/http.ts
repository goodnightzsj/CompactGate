import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import https from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  CompactGateConfig,
  HealthResponse,
  RequestLogEntry,
  RequestLogPage,
  RequestTransport,
  RouteKind,
  StudioLogEvent,
  StudioSnapshotEvent
} from "../shared/types.js";
import { CompactionBridgeStore } from "./compaction-bridge.js";
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

export interface CompactGateApp {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

function createRequestLogger(configStore: ConfigStore): RequestLogger {
  return new RequestLogger(
    configStore.get().logging.keep_recent,
    resolveLogDatabasePath(configStore.getConfigPath(), process.env.COMPACTGATE_LOG_DB)
  );
}

function createDebugCaptureWriter(): DebugCaptureWriter {
  return DebugCaptureWriter.fromEnv();
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
  studioEvents = new StudioEventBroadcaster()
): http.Server {
  const app = createCompactGateApp(
    configStore,
    logger,
    captureWriter,
    compactionBridge,
    studioEvents
  );
  const server = http.createServer(app.handler);
  server.once("close", () => {
    logger.close();
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
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://compactgate.local");

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url, configStore, logger, studioEvents);
      return;
    }

    if (isAnthropicProxyPath(url.pathname)) {
      await proxyClaudeRequest(req, res, url, configStore, logger, captureWriter, studioEvents);
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
    const host = parseHostFilter(url.searchParams.get("host"));
    const limit = parsePositiveInteger(url.searchParams.get("limit"), configStore.get().logging.keep_recent);
    const offset = parseNonNegativeInteger(url.searchParams.get("offset"), 0);
    sendJson(res, 200, logger.page({ route, host, limit, offset }));
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
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  const startedAt = performance.now();
  const config = configStore.get();
  const route: RouteKind = "claude";
  const requestId = randomUUID();
  const upstreamPath = stripAnthropicProxyPrefix(url.pathname);
  const upstream = buildClaudeUpstreamUrl(config.claude.base_url, upstreamPath, url.search);
  const auth = resolveRouteCredential("claude", config);
  let requestHeaders: Record<string, string> = {};
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
    requestHeaders = buildAnthropicUpstreamHeaders(req.headers, auth.apiKey);

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
        "x-compactgate-request-id": requestId
      }
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
        body: serializeBody(rawBody)
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

    const result = await sendBufferedUpstreamRequest({
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
      }
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

    const result = await sendBufferedUpstreamRequest({
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
      }
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
}

interface BufferedUpstreamResult {
  status: number;
  errorSummary: string | null;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
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

    upstreamReq = client.request(
      options.upstream,
      {
        method: options.req.method,
        headers,
        timeout: options.timeoutMs
      },
      (response) => {
        upstreamRes = response;
        const status = response.statusCode ?? 502;
        const responseChunks: Buffer[] = [];
        let firstTokenMs: number | null = null;
        copyResponseHeaders(response.headers, options.res);
        for (const [name, value] of Object.entries(options.extraResponseHeaders)) {
          options.res.setHeader(name, value);
        }
        options.res.writeHead(status);
        response.on("data", (chunk: Buffer) => {
          firstTokenMs ??= Math.max(0, Math.round(performance.now() - options.startedAt));
          responseChunks.push(Buffer.from(chunk));
        });
        response.on("aborted", handleUpstreamResponseAborted);
        response.on("error", handleUpstreamResponseError);
        response.pipe(options.res);

        response.on("end", () => {
          resolveOnce({
            status,
            errorSummary: null,
            responseBody: Buffer.concat(responseChunks),
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
  const claudeCredential = resolveRouteCredential("claude", config);

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
      status: statusForBaseUrl(config.claude.base_url),
      base_url: config.claude.base_url,
      host: hostOrNull(config.claude.base_url),
      api_key_env: config.claude.api_key_env,
      stored_api_key: config.claude.api_key.trim().length > 0,
      api_key_configured: claudeCredential.apiKeyConfigured,
      api_key_source: claudeCredential.apiKeySource,
      active_api_key_env: claudeCredential.activeApiKeyEnv,
      active_credential_scope: claudeCredential.activeCredentialScope
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
