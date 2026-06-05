import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  ClaudeModelMapRole,
  CompactGateConfig,
  RequestLogEntry,
  RequestTransport,
  RouteKind
} from "../shared/types.js";
import { handleApi } from "./api-routes.js";
import { CompactionBridgeStore } from "./compaction-bridge.js";
import { ConfigStore } from "./config.js";
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
import { hostOrNull } from "./health.js";
import {
  buildUpstreamHeaders,
  copyResponseHeaders,
  endpointFromPath,
  isRecord,
  parseJsonRecord,
  readHeaderString,
  readRawBody,
  sendJson,
  statusForError,
  summaryForError
} from "./http-utils.js";
import { serveStatic } from "./static-assets.js";
import { StudioEventBroadcaster } from "./studio-events.js";
import {
  requestJson,
  sendBufferedUpstreamRequest,
  sendOpenAiUpstreamRequest,
  UpstreamStatusError,
  type BufferedUpstreamResult
} from "./upstream-client.js";

const ANTHROPIC_PROXY_PREFIX = "/anthropic";
const CLAUDE_ANYROUTER_COMPACT_MIN_RECONNECT_COUNT = 3;
const DEFAULT_CLAUDE_ANYROUTER_COMPACT_MIN_BODY_BYTES = 1_101_329;

type ClaudeSubRoute = "primary" | "compact";

interface ClaudeManualCompactRoutingState {
  armed: boolean;
}

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

export function createCompactGateApp(
  configStore: ConfigStore,
  logger = createRequestLogger(configStore),
  captureWriter = createDebugCaptureWriter(),
  compactionBridge = new CompactionBridgeStore(),
  studioEvents = new StudioEventBroadcaster()
): CompactGateApp {
  const claudeManualCompactRouting: ClaudeManualCompactRoutingState = { armed: false };
  return {
    handler: (req, res) => {
      void routeRequest(
        req,
        res,
        configStore,
        logger,
        captureWriter,
        compactionBridge,
        studioEvents,
        claudeManualCompactRouting
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
  studioEvents: StudioEventBroadcaster,
  claudeManualCompactRouting: ClaudeManualCompactRoutingState
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://compactgate.local");

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url, configStore, logger, studioEvents, fetchClaudeModels);
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
        claudeManualCompactRouting
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
  studioEvents: StudioEventBroadcaster,
  claudeManualCompactRouting: ClaudeManualCompactRoutingState
): Promise<void> {
  const startedAt = performance.now();
  const config = configStore.get();
  const route: RouteKind = "claude";
  const requestId = randomUUID();
  const upstreamPath = stripAnthropicProxyPrefix(url.pathname);
  let upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
  let claudeRoute: ClaudeSubRoute = "primary";
  let responseClaudeRoute: ClaudeSubRoute = "primary";
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
  let targetModel: string | null = null;
  let usage: TokenUsageMetrics = emptyUsageMetrics();

  try {
    rawBody = await readRawBody(req, 100 * 1024 * 1024);
    requestMetadata = extractRequestMetadata(upstreamPath, rawBody);
    requestType = requestMetadata.requestType;
    sourceModel = extractSourceModel(rawBody);
    const isManualCompact = isClaudeManualCompactRequest(upstreamPath, rawBody);
    const shouldRouteManualCompactToCompact = isManualCompact && claudeManualCompactRouting.armed;
    if (isManualCompact) {
      claudeManualCompactRouting.armed = false;
    } else if (shouldArmClaudeManualCompactRouting(config, upstreamPath, rawBody)) {
      claudeManualCompactRouting.armed = true;
    }

    claudeRoute = shouldRouteManualCompactToCompact ? "compact" : "primary";
    targetModel = claudeRoute === "compact"
      ? readStringField(config.claude.compact.model_override) ?? sourceModel
      : resolveClaudeMappedModel(sourceModel, config) ?? sourceModel;
    upstream = buildClaudeUpstreamUrl(
      claudeRoute === "compact" ? claudeCompactUpstreamBaseUrl(config) : config.claude.primary.base_url,
      upstreamPath,
      url.search
    );
    upstreamBody = claudeRoute === "compact"
      ? rewriteClaudeManualCompactBody(rawBody, config.claude.compact.model_override)
      : rewriteClaudeModelBody(rawBody, targetModel ?? "");
    const auth = resolveClaudeCredential(claudeRoute, config);
    requestHeaders = buildAnthropicUpstreamHeaders(req.headers, auth.apiKey);

    let finalResult: BufferedUpstreamResult | null = null;

    if (!finalResult) {
      const result = await sendBufferedUpstreamRequest({
        req,
        res,
        upstream,
        startedAt,
        timeoutMs: config.timeouts.claude_ms,
        timeoutMessage: "Claude upstream request timed out.",
        requestHeaders,
        body: upstreamBody,
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
      path: `${upstreamPath}${url.search}`,
      upstream_url: upstream.toString(),
      upstream_host: upstream.host,
      source_model: sourceModel,
      target_model: targetModel,
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
  let route: RouteKind = "primary";
  let upstream = buildUpstreamUrl(config.primary.base_url, url.pathname, url.search);
  let auth = resolveRouteCredential("primary", config);
  let timeoutMs = config.timeouts.primary_ms;
  let timeoutMessage = "Primary upstream request timed out.";
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

    const useCompactFollowUp =
      config.compact.upstream_mode === "split" &&
      compactionBridge.consumeCompactFollowUp(rawBody);
    if (useCompactFollowUp) {
      route = "compact";
      upstream = buildUpstreamUrl(compactUpstreamBaseUrl(config), url.pathname, url.search);
      auth = resolveRouteCredential("compact", config);
      timeoutMs = config.timeouts.compact_ms;
      timeoutMessage = "Compact upstream request timed out.";
      upstreamBody = rawBody;
    } else {
      const bridgeResult =
        config.compact.upstream_mode === "split"
          ? compactionBridge.rewritePrimaryBody(rawBody)
          : { body: rawBody, replacedCompactionCount: 0 };
      upstreamBody = bridgeResult.body;
      compactBridgeReplacements = bridgeResult.replacedCompactionCount;
    }
    requestHeaders = buildUpstreamHeaders(req.headers, auth.apiKey);

    const result = await sendOpenAiUpstreamRequest({
      req,
      res,
      upstream,
      startedAt,
      timeoutMs,
      timeoutMessage,
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
    if (route === "compact" && status >= 200 && status < 300) {
      compactionBridge.storeCompactResponse(responseBody, { armFollowUp: false });
    }
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
      compactionBridge.storeCompactResponse(responseBody, {
        armFollowUp: config.compact.upstream_mode === "split"
      });
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
    cache_read_input_tokens: input.usage.cacheReadInputTokens,
    cache_creation_input_tokens: input.usage.cacheCreationInputTokens,
    reasoning_tokens: input.usage.reasoningTokens,
    additive_cached_input_tokens: input.usage.additiveCachedInputTokens === true,
    additive_cached_output_tokens: input.usage.additiveCachedOutputTokens === true,
    total_tokens: input.usage.totalTokens,
    upstream_host: input.upstreamHost,
    user_agent: readHeaderString(input.req.headers["user-agent"]),
    request_id: input.requestId,
    error_summary: input.errorSummary
  };
  logger.add(entry);
  return entry;
}

function emptyUsageMetrics(): TokenUsageMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cachedOutputTokens: null,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    reasoningTokens: null,
    totalTokens: null
  };
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

function resolveClaudeMappedModel(
  sourceModel: string | null,
  config: CompactGateConfig
): string | null {
  const role = classifyClaudeModelRole(sourceModel);
  const roleTarget = role ? readStringField(config.claude.model_map[role]) : null;
  if (roleTarget) {
    return roleTarget;
  }

  return readStringField(config.claude.model_map.default);
}

function classifyClaudeModelRole(sourceModel: string | null): ClaudeModelMapRole | null {
  const normalized = sourceModel?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "subagent" || normalized.includes("subagent")) {
    return "subagent";
  }

  if (normalized === "reasoning" || normalized.includes("reasoning") || normalized.includes("thinking")) {
    return "reasoning";
  }

  if (normalized === "haiku" || normalized.includes("haiku")) {
    return "haiku";
  }

  if (normalized === "sonnet" || normalized.includes("sonnet")) {
    return "sonnet";
  }

  if (normalized === "opus" || normalized === "opusplan" || normalized.includes("opus")) {
    return "opus";
  }

  if (normalized === "default" || normalized === "best") {
    return "default";
  }

  return null;
}

function shouldArmClaudeManualCompactRouting(
  config: CompactGateConfig,
  requestPath: string,
  rawBody: Buffer
): boolean {
  if (!isClaudeAnyRouterPrimary(config)) {
    return false;
  }

  const endpoint = endpointFromPath(requestPath);
  if (endpoint !== "/messages") {
    return false;
  }

  if (rawBody.byteLength < claudeAnyRouterCompactMinBodyBytes()) {
    return false;
  }

  const parsed = parseJsonRecord(rawBody);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return false;
  }

  const reconnectCount = readClaudeReconnectCount(parsed);
  return reconnectCount !== null && reconnectCount >= CLAUDE_ANYROUTER_COMPACT_MIN_RECONNECT_COUNT;
}

function isClaudeAnyRouterPrimary(config: CompactGateConfig): boolean {
  try {
    const baseUrl = new URL(config.claude.primary.base_url);
    const marker = `${baseUrl.hostname} ${baseUrl.pathname}`.toLowerCase();
    return marker.includes("anyrouter");
  } catch {
    return false;
  }
}

function claudeAnyRouterCompactMinBodyBytes(): number {
  const rawValue = process.env.COMPACTGATE_CLAUDE_ANYROUTER_COMPACT_BYTES;
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_CLAUDE_ANYROUTER_COMPACT_MIN_BODY_BYTES;
  }

  return parsed;
}

function isClaudeManualCompactRequest(requestPath: string, rawBody: Buffer): boolean {
  if (endpointFromPath(requestPath) !== "/messages") {
    return false;
  }

  const parsed = parseJsonRecord(rawBody);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return false;
  }

  const text = collectTextContent(parsed.messages).toLowerCase();
  return text.includes("your task is to create a detailed summary of the conversation so far") &&
    text.includes("critical: respond with text only") &&
    text.includes("<summary>");
}

function rewriteClaudeManualCompactBody(rawBody: Buffer, compactModelOverride: string): Buffer {
  return rewriteClaudeModelBody(rawBody, compactModelOverride);
}

function rewriteClaudeModelBody(rawBody: Buffer, modelOverride: string): Buffer {
  const model = readStringField(modelOverride);
  if (!model) {
    return rawBody;
  }

  const parsed = parseJsonRecord(rawBody);
  if (!parsed) {
    return rawBody;
  }

  return Buffer.from(JSON.stringify({
    ...parsed,
    model
  }));
}

async function fetchClaudeModels(config: CompactGateConfig): Promise<{
  models: string[];
  upstream_host: string;
  error: string | null;
}> {
  const upstreams = buildClaudeModelListUrls(config.claude.primary.base_url);
  const auth = resolveClaudeCredential("primary", config);
  const headers = buildAnthropicUpstreamHeaders(
    {
      "anthropic-version": "2023-06-01"
    },
    auth.apiKey
  );
  const errors: string[] = [];

  for (const upstream of upstreams) {
    try {
      const body = await requestJson(upstream, headers, config.timeouts.claude_ms);
      return {
        models: extractModelIds(body),
        upstream_host: upstream.host,
        error: null
      };
    } catch (error) {
      errors.push(`${upstream.pathname}: ${claudeModelFetchError(error)}`);

      if (!shouldTryNextClaudeModelsPath(error)) {
        break;
      }
    }
  }

  return {
    models: [],
    upstream_host: upstreams[0]?.host ?? hostOrNull(config.claude.primary.base_url) ?? "",
    error: `上游模型列表不可用。已尝试 ${errors.join("；")}`
  };
}

function buildClaudeModelListUrls(baseUrl: string): URL[] {
  const candidates = [
    buildClaudeUpstreamUrl(baseUrl, "/v1/models"),
    buildClaudeUpstreamUrl(baseUrl, "/models")
  ];
  const rootBase = new URL(baseUrl);
  rootBase.pathname = "/";
  rootBase.search = "";
  rootBase.hash = "";
  candidates.push(
    buildClaudeUpstreamUrl(rootBase.toString(), "/v1/models"),
    buildClaudeUpstreamUrl(rootBase.toString(), "/models")
  );

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toString();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function shouldTryNextClaudeModelsPath(error: unknown): boolean {
  if (error instanceof UpstreamStatusError) {
    return error.status === 404 || error.status === 405;
  }

  return false;
}

function claudeModelFetchError(error: unknown): string {
  if (error instanceof UpstreamStatusError) {
    if (error.status === 401 || error.status === 403) {
      return `认证失败，状态码 ${error.status}`;
    }

    return `状态码 ${error.status}`;
  }

  return summaryForError(error);
}

function extractModelIds(value: unknown): string[] {
  const models = new Set<string>();
  const candidates = isRecord(value) && Array.isArray(value.data) ? value.data : Array.isArray(value) ? value : [];

  for (const item of candidates) {
    if (typeof item === "string") {
      models.add(item);
      continue;
    }

    if (!isRecord(item)) {
      continue;
    }

    const id = readStringField(item.id) ?? readStringField(item.name) ?? readStringField(item.model);
    if (id) {
      models.add(id);
    }
  }

  return [...models].sort((left, right) => left.localeCompare(right));
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

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function collectTextContent(value: unknown, depth = 0): string {
  if (depth > 10) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    if (!isRecord(value)) {
      return "";
    }

    return Object.entries(value)
      .filter(([key]) => key !== "encrypted_content")
      .map(([, child]) => collectTextContent(child, depth + 1))
      .filter((item) => item.length > 0)
      .join("\n");
  }

  return value
    .map((item) => collectTextContent(item, depth + 1))
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
