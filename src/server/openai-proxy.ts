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
  primaryRouteRequestContextFromBody,
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
  classifyOpenAiRequest,
  extractJsonModel,
  hasRemoteV2CompactionState,
  type OpenAiRequestClassification
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
  classifyOpenAiUpstreamResult,
  sendOpenAiUpstreamRequest,
  summarizeOpenAiStreamFailure,
  UpstreamRequestError
} from "./upstream-client.js";
import type { CodexVersionMonitor } from "./codex-version.js";

export async function proxyOpenAiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  compactionBridge: CompactionBridgeStore,
  studioEvents: StudioEventBroadcaster,
  primaryFailover: PrimaryFailoverState,
  codexVersionMonitor: CodexVersionMonitor
): Promise<void> {
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  const config = configStore.get();
  const classification = classifyOpenAiRequest(url.pathname);
  const requestId = randomUUID();

  if (classification.route === "compact" && classification.compactionMode !== "remote_v2") {
    await proxyCompactRequest(
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
      codexVersionMonitor,
      requestId,
      startedAtIso,
      startedAt,
      classification
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
    codexVersionMonitor,
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
  codexVersionMonitor: CodexVersionMonitor,
  requestId: string,
  startedAtIso: string,
  startedAt: number
): Promise<void> {
  let route: RouteKind = "primary";
  let classification: OpenAiRequestClassification = {
    route: "primary",
    compactionMode: null,
    detectionSource: null
  };
  let delegatedToCompact = false;
  let primarySelection: PrimaryRouteSelection | null = null;
  let upstream = new URL(config.primary.base_url);
  const transaction = createOpenAiProxyTransactionState();

  try {
    transaction.rawBody = await readRawBody(req);
    transaction.requestMetadata = extractRequestMetadata(url.pathname, transaction.rawBody);
    transaction.requestType = transaction.requestMetadata.requestType;
    classification = classifyOpenAiRequest(url.pathname, transaction.rawBody, req.headers);
    if (classification.route === "compact" && classification.compactionMode !== "remote_v2") {
      delegatedToCompact = true;
      await proxyCompactRequest(
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
        codexVersionMonitor,
        requestId,
        startedAtIso,
        startedAt,
        classification,
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
      primaryFailover,
      preserveRemoteV2State: hasRemoteV2CompactionState(url.pathname, transaction.rawBody, req.headers)
    });
    route = classification.route;
    upstream = plan.upstream;
    primarySelection = plan.primarySelection;
    await syncScheduledPrimaryProfile({
      config,
      configStore,
      logger,
      primarySelection,
      studioEvents,
      codexVersionMonitor
    });
    transaction.sourceModel = plan.sourceModel;
    transaction.targetModel = plan.targetModel;
    transaction.upstreamBody = plan.upstreamBody;
    transaction.requestMetadata.reasoningEffort = extractRequestMetadata(
      url.pathname,
      transaction.upstreamBody
    ).reasoningEffort;
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
        ...compactionResponseHeaders(classification),
        "x-compactgate-request-id": requestId
      },
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY,
      retryEmptyStreamError: transaction.requestType === "stream"
    });

    applyOpenAiProxyUpstreamResult(transaction, result);
    transaction.streamOutcome = classifyOpenAiUpstreamResult(result);
    transaction.requestType = responseTransport(transaction.responseHeaders) ?? transaction.requestType;
    transaction.usage = extractResponseUsage(transaction.responseBody, transaction.responseHeaders);
    if (transaction.requestMetadata.requestType === "stream") {
      transaction.errorSummary ??= summarizeOpenAiStreamFailure(result);
    }
  } catch (error) {
    applyUpstreamFailureToTransaction(transaction, error);
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

    if (primarySelection) {
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
        codexVersionMonitor,
      route,
      compactionMode: classification.compactionMode,
      compactionDetectionSource: classification.detectionSource,
      req,
      url,
      status: transaction.status,
      upstreamStatus: transaction.upstreamStatus,
      streamTerminalEvent: transaction.streamTerminalEvent,
      clientDisconnectPhase: transaction.clientDisconnectPhase,
      streamOutcome: transaction.streamOutcome,
      streamOversizedEventCount: transaction.streamOversizedEventCount,
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
  studioEvents,
  codexVersionMonitor
}: {
  config: CompactGateConfig;
  configStore: ConfigStore;
  logger: RequestLogger;
  primarySelection: PrimaryRouteSelection | null;
  studioEvents: StudioEventBroadcaster;
  codexVersionMonitor: CodexVersionMonitor;
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
  studioEvents.broadcastSnapshot(createStudioSnapshot(configStore, logger, codexVersionMonitor));
}

async function proxyCompactRequest(
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
  codexVersionMonitor: CodexVersionMonitor,
  requestId: string,
  startedAtIso: string,
  startedAt: number,
  classification: Extract<OpenAiRequestClassification, { route: "compact" }>,
  prepared?: {
    rawBody: Buffer;
    requestMetadata: RequestMetadata;
  }
): Promise<void> {
  const route: RouteKind = "compact";
  let upstream = new URL(config.compact.base_url);
  let attemptedUpstream = false;
  let primarySelection: PrimaryRouteSelection | null = null;
  const transaction = createOpenAiProxyTransactionState();

  try {
    transaction.rawBody = prepared?.rawBody ?? await readRawBody(req);
    transaction.requestMetadata = prepared?.requestMetadata ?? extractRequestMetadata(url.pathname, transaction.rawBody);
    transaction.requestType = transaction.requestMetadata.requestType;
    const selectedPrimary = config.compact.upstream_mode === "primary"
      ? primaryFailover.preview(
          config,
          primaryRouteRequestContextFromBody(
            transaction.rawBody,
            req.headers,
            transaction.requestMetadata.endpoint
          )
        )
      : null;
    const plan = buildCompactOpenAiProxyPlan({
      config: selectedPrimary?.config ?? config,
      url,
      headers: req.headers,
      rawBody: transaction.rawBody
    });
    if (selectedPrimary) {
      primaryFailover.reserveSelection(selectedPrimary, config.primary_failover.auto_schedule);
      primarySelection = selectedPrimary;
      await syncScheduledPrimaryProfile({
        config,
        configStore,
        logger,
        primarySelection,
        studioEvents,
        codexVersionMonitor
      });
    }
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
    const cachedCompactResponse = classification.compactionMode === "remote_v1"
      ? compactionBridge.getCachedCompactResponse(dedupeInput)
      : null;
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
          ...compactionResponseHeaders(classification),
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
        ...compactionResponseHeaders(classification),
        "x-compactgate-model": transaction.targetModel ?? "",
        "x-compactgate-request-id": requestId
      },
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY
    });

    applyOpenAiProxyUpstreamResult(transaction, result);
    transaction.streamOutcome = classifyOpenAiUpstreamResult(result);
    // 远程压缩归一化仅用于桥接存储和诊断日志,不写回客户端。本地摘要压缩返回普通
    // Responses 流,不能把它误记为缺失 compaction output。
    const normalizedResponse = classification.compactionMode === "remote_v1"
      ? normalizeCompactResponse({
          status: transaction.status,
          responseBody: transaction.responseBody,
          responseHeaders: transaction.responseHeaders,
          requestBody: transaction.upstreamBody
        })
      : {
          body: transaction.responseBody,
          headers: transaction.responseHeaders,
          normalized: false,
          reason: null,
          syntheticSource: null
        };
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
      if (classification.compactionMode === "remote_v1") {
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
    }
  } catch (error) {
    applyUpstreamFailureToTransaction(transaction, error);
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
    if (primarySelection) {
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
      codexVersionMonitor,
      route,
      compactionMode: classification.compactionMode,
      compactionDetectionSource: classification.detectionSource,
      req,
      url,
      status: transaction.status,
      upstreamStatus: transaction.upstreamStatus,
      streamTerminalEvent: transaction.streamTerminalEvent,
      clientDisconnectPhase: transaction.clientDisconnectPhase,
      streamOutcome: transaction.streamOutcome,
      streamOversizedEventCount: transaction.streamOversizedEventCount,
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

function compactionResponseHeaders(
  classification: OpenAiRequestClassification
): Record<string, string> {
  return classification.route === "compact"
    ? { "x-compactgate-compaction-mode": classification.compactionMode }
    : {};
}

function applyUpstreamFailureToTransaction(
  transaction: ReturnType<typeof createOpenAiProxyTransactionState>,
  error: unknown
): void {
  if (!(error instanceof UpstreamRequestError)) {
    return;
  }

  transaction.upstreamStatus = error.details.status;
  transaction.responseBody = error.details.responseBody;
  transaction.responseHeaders = error.details.responseHeaders;
  transaction.firstTokenMs = error.details.firstTokenMs;
  transaction.streamTerminalEvent = error.details.streamSummary?.terminalEvent ?? null;
  transaction.clientDisconnectPhase = error.details.clientDisconnectPhase;
  transaction.streamOversizedEventCount = error.details.streamSummary?.oversizedEventCount ?? 0;
  transaction.streamOutcome = error.details.kind === "client_cancel"
    ? error.details.clientDisconnectPhase === "after_terminal"
      ? "client_cancel_after_terminal"
      : "client_cancel"
    : error.details.kind;
}

function applyCachedCompactResponse(
  transaction: ReturnType<typeof createOpenAiProxyTransactionState>,
  cached: CachedCompactResponse
): void {
  transaction.status = cached.status;
  transaction.upstreamStatus = cached.status;
  transaction.streamOutcome = cached.status >= 400 ? "upstream_http_error" : "success";
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
