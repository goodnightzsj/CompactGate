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
    sendJson(res, 200, { logs: logger.recent(route) });
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

  try {
    rawBody = await readRawBody(req);
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
      upstreamHost: upstream.host,
      requestId,
      sourceModel,
      targetModel: sourceModel,
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

  try {
    rawBody = await readRawBody(req);
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
      upstreamHost: upstream.host,
      requestId,
      sourceModel,
      targetModel,
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
    const upstreamReq = client.request(
      options.upstream,
      {
        method: options.req.method,
        headers,
        timeout: options.timeoutMs
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const responseChunks: Buffer[] = [];
        copyResponseHeaders(upstreamRes.headers, options.res);
        for (const [name, value] of Object.entries(options.extraResponseHeaders)) {
          options.res.setHeader(name, value);
        }
        options.res.writeHead(status);
        upstreamRes.on("data", (chunk: Buffer) => {
          responseChunks.push(Buffer.from(chunk));
        });
        upstreamRes.pipe(options.res);

        upstreamRes.on("end", () => {
          resolve({
            status,
            errorSummary: null,
            responseBody: Buffer.concat(responseChunks),
            responseHeaders: upstreamRes.headers
          });
        });
      }
    );

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error(options.timeoutMessage));
    });

    upstreamReq.on("error", (error) => {
      reject(error);
    });

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
    upstreamHost: string;
    requestId: string;
    sourceModel: string | null;
    targetModel: string | null;
    errorSummary: string | null;
  }
): RequestLogEntry {
  const entry: RequestLogEntry = {
    time: new Date().toISOString(),
    route: input.route,
    method: input.req.method ?? "GET",
    path: `${input.url.pathname}${input.url.search}`,
    source_model: input.sourceModel,
    target_model: input.targetModel,
    status: input.status,
    duration_ms: Math.max(0, Math.round(performance.now() - input.startedAt)),
    upstream_host: input.upstreamHost,
    request_id: input.requestId,
    error_summary: input.errorSummary
  };
  logger.add(entry);
  return entry;
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
  return {
    config: configStore.toPublicConfig(),
    health: healthForConfig(configStore.get()),
    logs: logger.recent()
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
  if (value === "primary" || value === "compact") {
    return value;
  }

  return undefined;
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
