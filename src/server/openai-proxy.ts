import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  CompactGateConfig,
  RouteKind
} from "../shared/types.js";
import {
  type CachedCompactResponse,
  CompactionBridgeStore,
  UnresolvedCompactionStateError
} from "./compaction-bridge.js";
import type { ConfigStore } from "./config.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import {
  copyResponseHeaders,
  RequestBodyTooLargeError,
  readRawBody,
  sendJson,
  summaryForError
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import {
  PrimaryFailoverState,
  type PrimaryRouteSelection
} from "./primary-failover.js";
import {
  buildCompactOpenAiProxyPlan,
  buildPrimaryOpenAiProxyPlan
} from "./openai-proxy-plan.js";
import {
  applyOpenAiProxyUpstreamResult,
  createOpenAiProxyTransactionState,
  finalizeOpenAiProxyTransaction
} from "./openai-proxy-transaction.js";
import {
  extractJsonModel,
  routeForPath
} from "./routing.js";
import {
  createStudioSnapshot,
  StudioEventBroadcaster
} from "./studio-events.js";
import { normalizeCompactResponse } from "./compact-response-normalizer.js";
import {
  extractRequestMetadata,
  extractResponseUsage,
  responseTransport,
  type RequestMetadata
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
  const startedAtIso = new Date().toISOString();
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
      startedAtIso,
      startedAt
    );
    return;
  }

  await proxyPrimaryRequest(
    req,
    res,
    url,
    config,
    configStore,
    logger,
    captureWriter,
    compactionBridge,
    studioEvents,
    primaryFailover,
    requestId,
    startedAtIso,
    startedAt
  );
}

async function proxyPrimaryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CompactGateConfig,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  compactionBridge: CompactionBridgeStore,
  studioEvents: StudioEventBroadcaster,
  primaryFailover: PrimaryFailoverState,
  requestId: string,
  startedAtIso: string,
  startedAt: number
): Promise<void> {
  let route: RouteKind = "primary";
  let delegatedToCompact = false;
  let primarySelection: PrimaryRouteSelection | null = null;
  let upstream = new URL(config.primary.base_url);
  const transaction = createOpenAiProxyTransactionState();

  try {
    transaction.rawBody = await readRawBody(req);
    transaction.requestMetadata = extractRequestMetadata(url.pathname, transaction.rawBody);
    transaction.requestType = transaction.requestMetadata.requestType;
    if (routeForPath(url.pathname, transaction.rawBody) === "compact") {
      delegatedToCompact = true;
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
        startedAtIso,
        startedAt,
        {
          rawBody: transaction.rawBody,
          requestMetadata: transaction.requestMetadata
        }
      );
      return;
    }

    const plan = buildPrimaryOpenAiProxyPlan({
      config,
      url,
      headers: req.headers,
      rawBody: transaction.rawBody,
      endpoint: transaction.requestMetadata.endpoint,
      compactionBridge,
      primaryFailover
    });
    route = plan.route;
    upstream = plan.upstream;
    primarySelection = plan.primarySelection;
    await syncScheduledPrimaryProfile({
      config,
      configStore,
      logger,
      primarySelection,
      studioEvents
    });
    transaction.sourceModel = plan.sourceModel;
    transaction.targetModel = plan.targetModel;
    transaction.upstreamBody = plan.upstreamBody;
    transaction.requestHeaders = plan.requestHeaders;
    transaction.compactBridgeReplacements = plan.compactBridgeReplacements;

    const result = await sendOpenAiUpstreamRequest({
      req,
      res,
      upstream,
      startedAt,
      timeoutMs: plan.timeoutMs,
      timeoutMessage: plan.timeoutMessage,
      requestHeaders: transaction.requestHeaders,
      body: transaction.upstreamBody,
      extraResponseHeaders: {
        "x-compactgate-route": route,
        "x-compactgate-request-id": requestId
      },
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY,
      retryEmptyStreamError: transaction.requestType === "stream"
    });

    applyOpenAiProxyUpstreamResult(transaction, result);
    transaction.requestType = responseTransport(transaction.responseHeaders) ?? transaction.requestType;
    transaction.usage = extractResponseUsage(transaction.responseBody, transaction.responseHeaders);
    if (route === "primary" && transaction.requestMetadata.requestType === "stream") {
      transaction.errorSummary ??= summarizeOpenAiStreamFailure(result);
    }
  } catch (error) {
    transaction.status = error instanceof RequestBodyTooLargeError
      ? 413
      : error instanceof UnresolvedCompactionStateError
        ? 422
        : 502;
    transaction.errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendJson(res, transaction.status, { error: transaction.errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(transaction.errorSummary));
    }
  } finally {
    if (delegatedToCompact) {
      return;
    }

    if (route === "primary" && primarySelection) {
      primaryFailover.recordResult(primarySelection, {
        status: transaction.status,
        errorSummary: transaction.errorSummary,
        responseBody: transaction.responseBody,
        responseHeaders: transaction.responseHeaders,
        firstTokenMs: transaction.firstTokenMs,
        usage: transaction.usage
      });
    }

    await finalizeOpenAiProxyTransaction({
      logger,
      captureWriter,
      studioEvents,
      route,
      req,
      url,
      status: transaction.status,
      startedAt,
      startedAtIso,
      requestMetadata: transaction.requestMetadata,
      requestType: transaction.requestType,
      upstream,
      requestId,
      sourceModel: transaction.sourceModel,
      targetModel: transaction.targetModel,
      firstTokenMs: transaction.firstTokenMs,
      usage: transaction.usage,
      errorSummary: transaction.errorSummary,
      compactBridgeReplacements: transaction.compactBridgeReplacements,
      rawBody: transaction.rawBody,
      requestHeaders: transaction.requestHeaders,
      upstreamBody: transaction.upstreamBody,
      responseBody: transaction.responseBody,
      responseHeaders: transaction.responseHeaders,
      clientResponseBody: transaction.clientResponseBody,
      clientResponseHeaders: transaction.clientResponseHeaders,
      persistBody: config.logging.persist_body,
      compactResponseNormalized: transaction.compactResponseNormalized,
      compactResponseNormalizeReason: transaction.compactResponseNormalizeReason,
      compactResponseSyntheticSource: transaction.compactResponseSyntheticSource
    });
  }
}

async function syncScheduledPrimaryProfile({
  config,
  configStore,
  logger,
  primarySelection,
  studioEvents
}: {
  config: CompactGateConfig;
  configStore: ConfigStore;
  logger: RequestLogger;
  primarySelection: PrimaryRouteSelection | null;
  studioEvents: StudioEventBroadcaster;
}): Promise<void> {
  const selectedProfileId = primarySelection?.profileId;
  const activeProfileId = config.profile_scopes?.codex?.active_profile_id ?? null;
  if (
    !config.primary_failover.auto_schedule ||
    !selectedProfileId ||
    selectedProfileId === activeProfileId
  ) {
    return;
  }

  await configStore.applyProfile("codex", selectedProfileId);
  studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger));
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
  startedAtIso: string,
  startedAt: number,
  prepared?: {
    rawBody: Buffer;
    requestMetadata: RequestMetadata;
  }
): Promise<void> {
  const route: RouteKind = "compact";
  let upstream = new URL(config.compact.base_url);
  let attemptedUpstream = false;
  const transaction = createOpenAiProxyTransactionState();

  try {
    transaction.rawBody = prepared?.rawBody ?? await readRawBody(req);
    transaction.requestMetadata = prepared?.requestMetadata ?? extractRequestMetadata(url.pathname, transaction.rawBody);
    transaction.requestType = transaction.requestMetadata.requestType;
    const plan = buildCompactOpenAiProxyPlan({
      config,
      url,
      headers: req.headers,
      rawBody: transaction.rawBody
    });
    upstream = plan.upstream;
    transaction.sourceModel = plan.sourceModel;
    transaction.targetModel = plan.targetModel;
    transaction.upstreamBody = plan.upstreamBody;
    transaction.requestHeaders = plan.requestHeaders;
    transaction.compactBridgeReplacements = plan.compactBridgeReplacements;

    const dedupeInput = {
      method: req.method ?? "POST",
      upstream: plan.upstream,
      authorization: transaction.requestHeaders.authorization ?? null,
      requestHeaders: transaction.requestHeaders,
      body: transaction.upstreamBody
    };
    const cachedCompactResponse = compactionBridge.getCachedCompactResponse(dedupeInput);
    if (cachedCompactResponse) {
      applyCachedCompactResponse(transaction, cachedCompactResponse);
      // 方案 B:Codex compact 期望原始上游 SSE 流,重放缓存的原始响应体而非归一化 JSON。
      transaction.clientResponseBody = null;
      transaction.clientResponseHeaders = null;
      writeBufferedProxyResponse(
        res,
        transaction.status,
        transaction.responseHeaders,
        transaction.responseBody,
        {
          "x-compactgate-route": route,
          "x-compactgate-model": transaction.targetModel ?? "",
          "x-compactgate-request-id": requestId
        }
      );
      return;
    }
    attemptedUpstream = true;

    // 方案 B:流式转发原始上游 SSE 流给客户端。Codex compact 用 collect_compaction_output 逐事件消费,
    // 需要 response.created / response.output_item.done / response.completed 事件;缓冲后转 JSON 会让客户端
    // 长时间收不到任何字节而断开(Client disconnected before upstream response completed)。
    // 完整响应同时缓冲在 transaction.responseBody,供归一化、桥接存储与 dedupe 重放使用。
    const result = await sendOpenAiUpstreamRequest({
      req,
      res,
      upstream,
      startedAt,
      timeoutMs: plan.timeoutMs,
      timeoutMessage: plan.timeoutMessage,
      requestHeaders: transaction.requestHeaders,
      body: transaction.upstreamBody,
      extraResponseHeaders: {
        "x-compactgate-route": route,
        "x-compactgate-model": transaction.targetModel ?? "",
        "x-compactgate-request-id": requestId
      },
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY
    });

    applyOpenAiProxyUpstreamResult(transaction, result);
    // 归一化仅用于桥接存储(提取 compaction item 与可读 summary)和诊断日志,不再写回客户端。
    // 客户端已通过上面的流式转发收到原始上游响应。
    const normalizedResponse = normalizeCompactResponse({
      status: transaction.status,
      responseBody: transaction.responseBody,
      responseHeaders: transaction.responseHeaders,
      requestBody: transaction.upstreamBody
    });
    transaction.compactResponseNormalized = normalizedResponse.normalized;
    transaction.compactResponseNormalizeReason = normalizedResponse.reason;
    transaction.compactResponseSyntheticSource = normalizedResponse.syntheticSource;
    transaction.requestType = responseTransport(transaction.responseHeaders) ?? transaction.requestType;
    transaction.usage = extractResponseUsage(transaction.responseBody, transaction.responseHeaders);
    if (result.streamSummary) {
      transaction.errorSummary ??= summarizeOpenAiStreamFailure(result);
    }
    if (
      transaction.status >= 200 &&
      transaction.status < 300 &&
      !transaction.errorSummary &&
      plan.compactBridgeScope
    ) {
      compactionBridge.storeCompactResponse(normalizedResponse.body, {
        scope: plan.compactBridgeScope,
        source: normalizedResponse.normalized ? "synthetic" : "standard"
      });
      compactionBridge.storeCompactDedupeResponse(dedupeInput, {
        status: transaction.status,
        responseBody: transaction.responseBody,
        responseHeaders: transaction.responseHeaders,
        clientResponseBody: normalizedResponse.body,
        clientResponseHeaders: normalizedResponse.headers,
        compactResponseNormalized: transaction.compactResponseNormalized,
        compactResponseNormalizeReason: transaction.compactResponseNormalizeReason,
        compactResponseSyntheticSource: transaction.compactResponseSyntheticSource,
        firstTokenMs: transaction.firstTokenMs
      });
    }
  } catch (error) {
    transaction.status = error instanceof RequestBodyTooLargeError ? 413 : attemptedUpstream ? 502 : 400;
    transaction.errorSummary = summaryForError(error);

    if (!transaction.sourceModel && transaction.rawBody.byteLength > 0) {
      transaction.sourceModel = extractJsonModel(transaction.rawBody).sourceModel;
    }

    if (!res.headersSent) {
      sendJson(res, transaction.status, { error: transaction.errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(transaction.errorSummary));
    }
  } finally {
    await finalizeOpenAiProxyTransaction({
      logger,
      captureWriter,
      studioEvents,
      route,
      req,
      url,
      status: transaction.status,
      startedAt,
      startedAtIso,
      requestMetadata: transaction.requestMetadata,
      requestType: transaction.requestType,
      upstream,
      requestId,
      sourceModel: transaction.sourceModel,
      targetModel: transaction.targetModel,
      firstTokenMs: transaction.firstTokenMs,
      usage: transaction.usage,
      errorSummary: transaction.errorSummary,
      compactBridgeReplacements: transaction.compactBridgeReplacements,
      rawBody: transaction.rawBody,
      requestHeaders: transaction.requestHeaders,
      upstreamBody: transaction.upstreamBody,
      responseBody: transaction.responseBody,
      responseHeaders: transaction.responseHeaders,
      clientResponseBody: transaction.clientResponseBody,
      clientResponseHeaders: transaction.clientResponseHeaders,
      persistBody: config.logging.persist_body,
      compactResponseNormalized: transaction.compactResponseNormalized,
      compactResponseNormalizeReason: transaction.compactResponseNormalizeReason,
      compactResponseSyntheticSource: transaction.compactResponseSyntheticSource
    });
  }
}

function applyCachedCompactResponse(
  transaction: ReturnType<typeof createOpenAiProxyTransactionState>,
  cached: CachedCompactResponse
): void {
  transaction.status = cached.status;
  transaction.responseBody = cached.responseBody;
  transaction.responseHeaders = cached.responseHeaders;
  transaction.clientResponseBody = cached.clientResponseBody;
  transaction.clientResponseHeaders = cached.clientResponseHeaders;
  transaction.compactResponseNormalized = cached.compactResponseNormalized;
  transaction.compactResponseNormalizeReason = cached.compactResponseNormalizeReason;
  transaction.compactResponseSyntheticSource = cached.compactResponseSyntheticSource;
  transaction.firstTokenMs = cached.firstTokenMs;
}

function writeBufferedProxyResponse(
  res: ServerResponse,
  status: number,
  headers: IncomingMessage["headers"],
  body: Buffer,
  extraResponseHeaders: Record<string, string>
): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  copyResponseHeaders(headers, res);
  for (const [name, value] of Object.entries(extraResponseHeaders)) {
    res.setHeader(name, value);
  }
  res.writeHead(status);
  res.end(body);
}
