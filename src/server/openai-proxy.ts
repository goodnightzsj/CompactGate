import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  CompactGateConfig,
  RequestTransport,
  RouteKind
} from "../shared/types.js";
import { CompactionBridgeStore } from "./compaction-bridge.js";
import type { ConfigStore } from "./config.js";
import { resolveRouteCredential } from "./credentials.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import { serializeHeaders } from "./debug-capture.js";
import {
  buildUpstreamHeaders,
  endpointFromPath,
  RequestBodyTooLargeError,
  readRawBody,
  sendJson,
  summaryForError
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import {
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody,
  type PrimaryRouteSelection
} from "./primary-failover.js";
import { addLog, emptyUsageMetrics, persistCapture } from "./proxy-support.js";
import {
  buildUpstreamUrl,
  compactUpstreamBaseUrl,
  compactUpstreamPath,
  deriveCompactModel,
  extractJsonModel,
  rewriteCompactBody,
  routeForPath
} from "./routing.js";
import { StudioEventBroadcaster } from "./studio-events.js";
import {
  extractRequestMetadata,
  extractResponseUsage,
  responseTransport,
  type RequestMetadata,
  type TokenUsageMetrics
} from "./usage.js";
import {
  sendOpenAiUpstreamRequest,
  summarizeOpenAiStreamFailure
} from "./upstream-client.js";

export async function proxyOpenAiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  compactionBridge: CompactionBridgeStore,
  studioEvents: StudioEventBroadcaster,
  primaryFailover: PrimaryFailoverState
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
    primaryFailover,
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
  primaryFailover: PrimaryFailoverState,
  requestId: string,
  startedAt: number
): Promise<void> {
  let route: RouteKind = "primary";
  let primarySelection: PrimaryRouteSelection | null = null;
  let upstream = buildUpstreamUrl(config.primary.base_url, url.pathname, url.search);
  let authApiKey = "";
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
    const compactBridgeScope = {
      compactUpstream: compactUpstreamBaseUrl(config),
      sourceModel,
      targetModel: sourceModel ? deriveCompactModel(sourceModel, config) : null
    };

    const useCompactFollowUp =
      config.compact.upstream_mode === "split" &&
      compactionBridge.consumeCompactFollowUp(rawBody, compactBridgeScope);
    if (useCompactFollowUp) {
      route = "compact";
      upstream = buildUpstreamUrl(compactUpstreamBaseUrl(config), url.pathname, url.search);
      authApiKey = resolveRouteCredential("compact", config).apiKey ?? "";
      timeoutMs = config.timeouts.compact_ms;
      timeoutMessage = "Compact upstream request timed out.";
      upstreamBody = rawBody;
    } else {
      primarySelection = primaryFailover.select(
        config,
        primaryRouteRequestContextFromBody(rawBody, req.headers, requestMetadata.endpoint)
      );
      const selectedPrimaryConfig = primarySelection.config;
      upstream = buildUpstreamUrl(selectedPrimaryConfig.primary.base_url, url.pathname, url.search);
      authApiKey = resolveRouteCredential("primary", selectedPrimaryConfig).apiKey ?? "";
      const bridgeResult =
        config.compact.upstream_mode === "split"
          ? compactionBridge.rewritePrimaryBody(rawBody, compactBridgeScope)
          : { body: rawBody, replacedCompactionCount: 0 };
      upstreamBody = bridgeResult.body;
      compactBridgeReplacements = bridgeResult.replacedCompactionCount;
    }
    requestHeaders = buildUpstreamHeaders(req.headers, authApiKey);
    if (upstreamBody !== rawBody) {
      delete requestHeaders["content-encoding"];
    }

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
    if (route === "primary" && requestMetadata.requestType === "stream") {
      errorSummary ??= summarizeOpenAiStreamFailure(result);
    }
    if (route === "compact" && status >= 200 && status < 300) {
      compactionBridge.storeCompactResponse(responseBody, {
        armFollowUp: false,
        scope: compactBridgeScope
      });
    }
  } catch (error) {
    status = error instanceof RequestBodyTooLargeError ? 413 : 502;
    errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendJson(res, status, { error: errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(errorSummary));
    }
  } finally {
    if (route === "primary" && primarySelection) {
      primaryFailover.recordResult(primarySelection, {
        status,
        errorSummary,
        responseBody,
        responseHeaders,
        firstTokenMs
      });
    }

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

    await persistCapture(captureWriter, () => ({
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
        body: captureWriter.serializeBody(rawBody)
      },
      upstream_request: {
        headers: serializeHeaders(requestHeaders),
        body: captureWriter.serializeBody(upstreamBody)
      },
      upstream_response: {
        status,
        headers: serializeHeaders(responseHeaders),
        body: captureWriter.serializeBody(responseBody)
      }
    }));
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
  const upstreamPath = compactUpstreamPath(config, url.pathname);
  const upstream = buildUpstreamUrl(compactUpstreamBaseUrl(config), upstreamPath, url.search);
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
    if (upstreamBody !== rawBody) {
      delete requestHeaders["content-encoding"];
    }

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
        armFollowUp: config.compact.upstream_mode === "split",
        scope: {
          compactUpstream: compactUpstreamBaseUrl(config),
          sourceModel,
          targetModel
        }
      });
    }
  } catch (error) {
    status = error instanceof RequestBodyTooLargeError ? 413 : attemptedUpstream ? 502 : 400;
    errorSummary = summaryForError(error);

    if (!sourceModel && rawBody) {
      sourceModel = extractJsonModel(rawBody).sourceModel;
    }

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
      targetModel,
      firstTokenMs,
      usage,
      errorSummary
    });
    studioEvents.broadcastLog(logEntry);

    await persistCapture(captureWriter, () => ({
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
        body: captureWriter.serializeBody(rawBody ?? Buffer.alloc(0))
      },
      upstream_request: {
        headers: serializeHeaders(requestHeaders),
        body: captureWriter.serializeBody(upstreamBody)
      },
      upstream_response: {
        status,
        headers: serializeHeaders(responseHeaders),
        body: captureWriter.serializeBody(responseBody)
      }
    }));
  }
}
