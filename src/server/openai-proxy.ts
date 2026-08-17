import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  CompactGateConfig,
  ProviderStatePortabilityLog,
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
  parseJsonRecord,
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
import { normalizeRequestContext } from "./primary-failover-context.js";
import { readResponseId } from "./primary-failover-result.js";
import {
  buildCompactOpenAiProxyPlan,
  buildPrimaryOpenAiProxyPlan,
  type OpenAiProxyPlan
} from "./openai-proxy-plan.js";
import {
  resolveRequestScopedProfile,
  type RequestScopedProfile
} from "./request-profile.js";
import {
  applyOpenAiProxyUpstreamResult,
  applyUpstreamFailureToTransaction,
  createOpenAiProxyTransactionState,
  finalizeFromTransaction,
  type OpenAiProxyTransactionState
} from "./openai-proxy-transaction.js";
import {
  classifyOpenAiRequest,
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
  classifyAnthropicUpstreamResult,
  classifyOpenAiUpstreamResult,
  sendOpenAiUpstreamRequest,
  summarizeOpenAiStreamFailure,
  summarizeAnthropicStreamFailure,
  UpstreamRequestError,
  writeBufferedUpstreamResult,
  type BufferedUpstreamResult,
  type UpstreamResponseTransform
} from "./upstream-client.js";
import { ProtocolConversionError } from "./protocol-conversion.js";
import {
  createAnthropicToResponsesCompactionResponseTransform,
  createAnthropicToResponsesResponseTransform,
  createChatToResponsesCompactionResponseTransform,
  createChatToResponsesResponseTransform
} from "./protocol-stream.js";
import {
  analyzeProviderState,
  type ProviderStateAnalysis
} from "./provider-state-portability.js";
import {
  runProviderStateMigration,
  type ProviderStateRecoveryTrigger,
  type ProviderStateMigrationResult
} from "./provider-state-migration.js";
import { providerStateBindingIdentityHashes } from "./provider-state-binding.js";
import {
  hashStateDomain,
  stateDomainForPrimary,
  stateDomainForProfile
} from "./provider-state-domain.js";
import {
  isEligibleGenericProviderStateFailure,
  PROVIDER_STATE_LEGACY_FAILURE_THRESHOLD,
  PROVIDER_STATE_LEGACY_FAILURE_TTL_MS,
  PROVIDER_STATE_TARGET_HEALTH_TTL_MS,
  providerStateLegacyFailureKey,
  providerStateTargetHealthKey,
  type ProviderStateTargetScope
} from "./provider-state-evidence.js";
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
  const baseConfig = configStore.get();
  const requestProfile = resolveRequestScopedProfile(
    baseConfig,
    "codex",
    req.headers,
    req.socket.remoteAddress
  );
  const config = requestProfile?.config ?? baseConfig;
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
      classification,
      requestProfile
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
    startedAt,
    requestProfile
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
  startedAt: number,
  requestProfile: RequestScopedProfile | null
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
  let providerStatePortability: ProviderStatePortabilityLog | null = null;
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
        requestProfile,
        {
          rawBody: transaction.rawBody,
          requestMetadata: transaction.requestMetadata
        }
      );
      return;
    }

    const primaryRequestContext = primaryRouteRequestContextFromBody(
      transaction.rawBody,
      req.headers,
      transaction.requestMetadata.endpoint
    );
    const inMemorySourceProfileId = requestProfile
      ? null
      : primaryFailover.boundProfileId(primaryRequestContext);
    const primarySelectionOverride: PrimaryRouteSelection | undefined = requestProfile
      ? {
          config,
          profileId: requestProfile.profileId,
          profileName: requestProfile.profileName,
          generation: 0,
          healthVersion: 0,
          context: normalizeRequestContext(primaryRequestContext)
        }
      : undefined;

    const plan = buildPrimaryOpenAiProxyPlan({
      config,
      url,
      headers: req.headers,
      rawBody: transaction.rawBody,
      endpoint: transaction.requestMetadata.endpoint,
      compactionBridge,
      primaryFailover,
      preserveRemoteV2State: hasRemoteV2CompactionState(url.pathname, transaction.rawBody, req.headers),
      primarySelectionOverride,
      reservePrimarySelection: !requestProfile,
      synthesizeRemoteV2Compaction: classification.route === "compact" &&
        classification.compactionMode === "remote_v2"
    });
    route = classification.route;
    upstream = plan.upstream;
    primarySelection = plan.primarySelection;
    if (!requestProfile) {
      await syncScheduledPrimaryProfile({
        config,
        configStore,
        logger,
        primarySelection,
        studioEvents,
        codexVersionMonitor
      });
    }
    transaction.sourceModel = plan.sourceModel;
    transaction.targetModel = plan.targetModel;
    transaction.upstreamBody = plan.upstreamBody;
    if (plan.upstreamProtocol === "openai_responses") {
      transaction.requestMetadata.reasoningEffort = extractRequestMetadata(
        url.pathname,
        transaction.upstreamBody
      ).reasoningEffort;
    }
    transaction.requestHeaders = plan.requestHeaders;
    transaction.sensitiveHeaderNames = plan.sensitiveHeaderNames;
    transaction.compactBridgeReplacements = plan.compactBridgeReplacements;

    const extraResponseHeaders = {
      "x-compactgate-route": route,
      ...compactionResponseHeaders(classification),
      ...requestProfileResponseHeaders(requestProfile),
      "x-compactgate-request-id": requestId
    };
    const bindingIdentityHashes = providerStateBindingIdentityHashes(primaryRequestContext);
    const persistedBinding = logger.findProviderStateBinding(bindingIdentityHashes);
    const sourceProfileId = persistedBinding?.profileId ?? inMemorySourceProfileId;
    const sourceStateDomain = persistedBinding?.stateDomainId ??
      stateDomainForProfile(config, inMemorySourceProfileId);
    const targetStateDomain = primarySelection
      ? stateDomainForPrimary(primarySelection.config.primary, primarySelection.profileId)
      : stateDomainForPrimary(config.primary);
    const stateAnalysis = analyzeProviderState(transaction.upstreamBody);
    const targetScope: ProviderStateTargetScope = {
      targetStateDomain,
      model: transaction.targetModel,
      endpoint: transaction.requestMetadata.endpoint
    };
    const targetHealthKey = providerStateTargetHealthKey(targetScope);
    const targetStateFreeSuccess = logger.hasProviderStateRecoveryEvidence(targetHealthKey);
    const recoveryEnabled = config.primary_failover.state_portability === "recover_on_error" &&
      plan.upstreamProtocol === "openai_responses";
    const recovery = recoveryEnabled && stateAnalysis.hasProviderOwnedState
      ? await sendRecoveringPrimaryRequest({
          req,
          res,
          upstream,
          startedAt,
          timeoutMs: plan.timeoutMs,
          timeoutMessage: plan.timeoutMessage,
          requestHeaders: transaction.requestHeaders,
          proxyUrl: plan.proxyUrl,
          canonicalBody: transaction.upstreamBody,
          extraResponseHeaders,
          targetStateDomain,
          startGenericRecovery: (result, afterErrorSpecificRepair) => {
            if (
              !targetStateFreeSuccess ||
              !isEligibleGenericProviderStateFailure(result, afterErrorSpecificRepair)
            ) {
              return null;
            }
            if (sourceStateDomain) {
              return sourceStateDomain === targetStateDomain
                ? null
                : "profile_switch_failure";
            }
            const conversationHash = bindingIdentityHashes[0];
            if (!conversationHash) {
              return null;
            }
            const count = logger.rememberProviderStateRecoveryEvidence(
              providerStateLegacyFailureKey(targetScope, conversationHash, result),
              "legacy_failure",
              PROVIDER_STATE_LEGACY_FAILURE_TTL_MS
            );
            return count >= PROVIDER_STATE_LEGACY_FAILURE_THRESHOLD
              ? "legacy_failure_threshold"
              : null;
          }
        })
      : null;
    if (recovery) {
      if (recovery.body !== transaction.upstreamBody) {
        delete transaction.requestHeaders["content-encoding"];
      }
      if (recovery.attempts.some((attempt) => attempt.strategy === "cross_domain")) {
        delete transaction.requestHeaders["x-codex-beta-features"];
      }
      transaction.upstreamBody = recovery.body;
    }
    const result = recovery?.result ?? await sendOpenAiUpstreamRequest({
      req,
      res,
      upstream,
      startedAt,
      timeoutMs: plan.timeoutMs,
      timeoutMessage: plan.timeoutMessage,
      requestHeaders: transaction.requestHeaders,
      proxyUrl: plan.proxyUrl,
      body: transaction.upstreamBody,
      extraResponseHeaders,
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY,
      retryEmptyStreamError: classification.route !== "compact" &&
        plan.upstreamProtocol === "openai_responses" &&
        transaction.requestType === "stream",
      retryHttpStatuses: classification.route === "compact" ? [502, 503, 504] : undefined,
      maxHttpStatusRetries: classification.route === "compact" ? 3 : 0,
      streamProtocol: plan.upstreamProtocol === "anthropic_messages" ? "anthropic" : "openai",
      responseTransform: pickResponseTransform(
        plan,
        classification.compactionMode === "remote_v2",
        transaction
      )
    });

    applyOpenAiProxyUpstreamResult(transaction, result);
    const { responseWasTransformed, clientResult } = applyClientResult(transaction, result, plan);
    const clientResponseBody = result.clientResponseBody ?? transaction.responseBody;
    const clientResponseHeaders = result.clientResponseHeaders ?? transaction.responseHeaders;
    transaction.requestType = responseTransport(clientResponseHeaders) ?? transaction.requestType;
    transaction.usage = extractResponseUsage(clientResponseBody, clientResponseHeaders);
    if (transaction.requestMetadata.requestType === "stream") {
      transaction.errorSummary ??= responseWasTransformed
        ? summarizeOpenAiStreamFailure(clientResult)
        : plan.upstreamProtocol === "anthropic_messages"
          ? summarizeAnthropicStreamFailure(result)
          : summarizeOpenAiStreamFailure(result);
    }
    providerStatePortability = buildProviderStatePortabilityLog({
      enabled: recoveryEnabled,
      conversationHash: bindingIdentityHashes[0] ?? null,
      sourceProfileId,
      targetProfileId: primarySelection?.profileId ?? null,
      sourceStateDomain,
      targetStateDomain,
      targetStateFreeSuccess,
      analysis: stateAnalysis,
      recovery
    });

    const completedSuccessfully =
      transaction.status >= 200 &&
      transaction.status < 300 &&
      transaction.streamOutcome === "success" &&
      transaction.errorSummary === null;
    if (completedSuccessfully && !stateAnalysis.hasProviderOwnedState) {
      logger.rememberProviderStateRecoveryEvidence(
        targetHealthKey,
        "target_health",
        PROVIDER_STATE_TARGET_HEALTH_TTL_MS
      );
    }
    if (
      primarySelection?.profileId &&
      completedSuccessfully
    ) {
      const responseId = readResponseId({
        status: transaction.status,
        errorSummary: null,
        responseBody: transaction.responseBody,
        responseHeaders: transaction.responseHeaders
      });
      const committedIdentityHashes = providerStateBindingIdentityHashes(
        primarySelection.context,
        responseId
      );
      logger.rememberProviderStateBinding(committedIdentityHashes, {
        stateDomainId: targetStateDomain,
        profileId: primarySelection.profileId,
        generation: (persistedBinding?.generation ?? 0) + (recovery?.trigger ? 1 : 0)
      }, Date.now(), Math.round((performance.timeOrigin + startedAt) * 1_000));
    }
  } catch (error) {
    if (error instanceof UpstreamRequestError) {
      applyUpstreamFailureToTransaction(transaction, error.details);
    }
    transaction.status = error instanceof ProtocolConversionError
      ? error.status
      : error instanceof RequestBodyTooLargeError
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

    if (primarySelection && !requestProfile) {
      primaryFailover.recordResult(primarySelection, {
        status: transaction.status,
        errorSummary: transaction.errorSummary,
        responseBody: transaction.responseBody,
        responseHeaders: transaction.responseHeaders,
        firstTokenMs: transaction.firstTokenMs,
        usage: transaction.usage
      });
    }

      await finalizeFromTransaction(transaction, {
        logger,
        captureWriter,
        studioEvents,
        codexVersionMonitor,
        route,
        compactionMode: classification.compactionMode,
        compactionDetectionSource: classification.detectionSource,
        req,
        url,
        startedAt,
        startedAtIso,
        upstream,
        requestId,
        providerStatePortability,
        persistBody: config.logging.persist_body
      });
  }
}

async function sendRecoveringPrimaryRequest(input: {
  req: IncomingMessage;
  res: ServerResponse;
  upstream: URL;
  startedAt: number;
  timeoutMs: number;
  timeoutMessage: string;
  requestHeaders: Record<string, string>;
  proxyUrl: string;
  canonicalBody: Buffer;
  extraResponseHeaders: Record<string, string>;
  targetStateDomain: string;
  startGenericRecovery: (
    result: Awaited<ReturnType<typeof sendOpenAiUpstreamRequest>>,
    afterErrorSpecificRepair: boolean
  ) => Exclude<ProviderStateRecoveryTrigger, "explicit_400"> | null;
}): Promise<ProviderStateMigrationResult> {
  const recovery = await runProviderStateMigration({
    canonicalBody: input.canonicalBody,
    targetStateDomain: input.targetStateDomain,
    canReplay: () =>
      !input.res.headersSent &&
      !input.res.writableEnded &&
      !input.res.destroyed &&
      performance.now() - input.startedAt < input.timeoutMs,
    startGenericRecovery: input.startGenericRecovery,
    send: (body, strategy, priorStrategy) => sendOpenAiUpstreamRequest({
      req: input.req,
      res: input.res,
      upstream: input.upstream,
      startedAt: input.startedAt,
      timeoutMs: Math.max(1, input.timeoutMs - Math.round(performance.now() - input.startedAt)),
      timeoutMessage: input.timeoutMessage,
      requestHeaders: requestHeadersForCompiledBody(
        input.requestHeaders,
        input.canonicalBody,
        body,
        strategy === "cross_domain" ||
          (strategy === "error_400" && priorStrategy === "cross_domain")
      ),
      proxyUrl: input.proxyUrl,
      body,
      extraResponseHeaders: input.extraResponseHeaders,
      deferHttpErrors: true,
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY
    })
  });
  if (recovery.result.status >= 400) {
    writeBufferedUpstreamResult(input.res, recovery.result, input.extraResponseHeaders);
  }
  return recovery;
}

function requestHeadersForCompiledBody(
  canonicalHeaders: Record<string, string>,
  canonicalBody: Buffer,
  compiledBody: Buffer,
  strictCrossDomain: boolean
): Record<string, string> {
  if (compiledBody === canonicalBody && !strictCrossDomain) {
    return canonicalHeaders;
  }

  const headers = { ...canonicalHeaders };
  if (compiledBody !== canonicalBody) {
    delete headers["content-encoding"];
  }
  if (strictCrossDomain) {
    delete headers["x-codex-beta-features"];
  }
  return headers;
}

function buildProviderStatePortabilityLog(input: {
  enabled: boolean;
  conversationHash: string | null;
  sourceProfileId: string | null;
  targetProfileId: string | null;
  sourceStateDomain: string | null;
  targetStateDomain: string;
  targetStateFreeSuccess: boolean;
  analysis: ProviderStateAnalysis;
  recovery: ProviderStateMigrationResult | null;
}): ProviderStatePortabilityLog {
  const decision: ProviderStatePortabilityLog["decision"] = !input.analysis.hasProviderOwnedState
    ? "not_applicable"
    : !input.enabled
      ? "disabled"
      : input.recovery?.trigger
        ? "recovery"
        : "observed";
  return {
    decision,
    trigger: input.recovery?.trigger ?? "none",
    target_state_free_success: input.targetStateFreeSuccess,
    conversation_hash: input.conversationHash,
    source_profile_id: input.sourceProfileId,
    target_profile_id: input.targetProfileId,
    source_state_domain_hash: input.sourceStateDomain
      ? hashStateDomain(input.sourceStateDomain)
      : null,
    target_state_domain_hash: hashStateDomain(input.targetStateDomain),
    stateful_item_counts: {
      reasoning: input.analysis.reasoningItemCount,
      encrypted_reasoning: input.analysis.encryptedReasoningItemCount,
      invalid_encrypted_reasoning: input.analysis.invalidEncryptedReasoningItemCount,
      compaction: input.analysis.compactionItemCount,
      previous_response_id: input.analysis.previousResponseIdPresent ? 1 : 0
    },
    attempts: (input.recovery?.attempts ?? []).map((attempt) => ({
      strategy: attempt.strategy,
      status: attempt.status,
      error_code: attempt.errorCode,
      body_hash: attempt.bodyHash,
      fidelity: attempt.compiled.fidelity,
      migration_counts: { ...attempt.compiled.metrics }
    }))
  };
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
  requestProfile: RequestScopedProfile | null,
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
    const selectedPrimary = !requestProfile && config.compact.upstream_mode === "primary"
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
      rawBody: transaction.rawBody,
      nativeCompaction: classification.compactionMode === "remote_v1"
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
    transaction.sensitiveHeaderNames = plan.sensitiveHeaderNames;
    transaction.compactBridgeReplacements = plan.compactBridgeReplacements;

    const dedupeInput = {
      method: req.method ?? "POST",
      upstream: plan.upstream,
      authorization: transaction.requestHeaders.authorization ?? null,
      requestHeaders: transaction.requestHeaders,
      proxyUrl: plan.proxyUrl,
      body: transaction.upstreamBody
    };
    const canDedupeCompactResponse = classification.compactionMode === "remote_v1" &&
      plan.upstreamProtocol === "openai_responses";
    const cachedCompactResponse = canDedupeCompactResponse
      ? compactionBridge.getCachedCompactResponse(dedupeInput)
      : null;
    if (cachedCompactResponse) {
      applyCachedCompactResponse(transaction, cachedCompactResponse);
      // 方案 B:Codex compact 期望原始上游 SSE 流,重放缓存的原始响应体而非归一化 JSON。
      transaction.clientResponseBody = null;
      transaction.clientResponseHeaders = null;
      writeBufferedUpstreamResult(
        res,
        cachedCompactResponse,
        {
          "x-compactgate-route": route,
          ...compactionResponseHeaders(classification),
          ...requestProfileResponseHeaders(requestProfile),
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
      proxyUrl: plan.proxyUrl,
      body: transaction.upstreamBody,
      extraResponseHeaders: {
        "x-compactgate-route": route,
        ...compactionResponseHeaders(classification),
        ...requestProfileResponseHeaders(requestProfile),
        "x-compactgate-model": transaction.targetModel ?? "",
        "x-compactgate-request-id": requestId
      },
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY,
      retryHttpStatuses: [502, 503, 504],
      maxHttpStatusRetries: 3,
      streamProtocol: plan.upstreamProtocol === "anthropic_messages" ? "anthropic" : "openai",
      responseTransform: pickResponseTransform(
        plan,
        classification.compactionMode === "remote_v1",
        transaction
      )
    });

    applyOpenAiProxyUpstreamResult(transaction, result);
    const { responseWasTransformed, clientResult } = applyClientResult(transaction, result, plan);
    const clientResponseBody = result.clientResponseBody ?? transaction.responseBody;
    const clientResponseHeaders = result.clientResponseHeaders ?? transaction.responseHeaders;
    // 远程压缩归一化仅用于桥接存储和诊断日志,不写回客户端。本地摘要压缩返回普通
    // Responses 流,不能把它误记为缺失 compaction output。
    const unnormalizedResponse = {
      body: clientResponseBody,
      headers: clientResponseHeaders,
      normalized: false,
      reason: null,
      syntheticSource: null
    };
    const normalizedResponse = classification.compactionMode === "remote_v1" &&
      plan.upstreamProtocol === "openai_responses"
      ? normalizeCompactResponse({
          status: transaction.status,
          responseBody: transaction.responseBody,
          responseHeaders: transaction.responseHeaders,
          requestBody: transaction.upstreamBody
        })
      : unnormalizedResponse;
    transaction.compactResponseNormalized = normalizedResponse.normalized;
    transaction.compactResponseNormalizeReason = normalizedResponse.reason;
    transaction.compactResponseSyntheticSource = normalizedResponse.syntheticSource;
    transaction.requestType = responseTransport(clientResponseHeaders) ?? transaction.requestType;
    transaction.usage = extractResponseUsage(clientResponseBody, clientResponseHeaders);
    if (responseWasTransformed && result.clientStreamSummary) {
      transaction.errorSummary ??= summarizeOpenAiStreamFailure(clientResult);
    } else if (result.streamSummary) {
      transaction.errorSummary ??= plan.upstreamProtocol === "anthropic_messages"
        ? summarizeAnthropicStreamFailure(result)
        : summarizeOpenAiStreamFailure(result);
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
        if (canDedupeCompactResponse) {
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
    }
  } catch (error) {
    if (error instanceof UpstreamRequestError) {
      applyUpstreamFailureToTransaction(transaction, error.details);
    }
    transaction.status = error instanceof ProtocolConversionError
      ? error.status
      : error instanceof RequestBodyTooLargeError
        ? 413
        : attemptedUpstream
          ? 502
          : 400;
    transaction.errorSummary = summaryForError(error);

    if (!transaction.sourceModel && transaction.rawBody.byteLength > 0) {
      const parsedBody = parseJsonRecord(transaction.rawBody);
      transaction.sourceModel = typeof parsedBody?.model === "string" ? parsedBody.model : null;
    }

    if (!res.headersSent) {
      sendJson(res, transaction.status, { error: transaction.errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(transaction.errorSummary));
    }
  } finally {
    if (primarySelection && !requestProfile) {
      primaryFailover.recordResult(primarySelection, {
        status: transaction.status,
        errorSummary: transaction.errorSummary,
        responseBody: transaction.responseBody,
        responseHeaders: transaction.responseHeaders,
        firstTokenMs: transaction.firstTokenMs,
        usage: transaction.usage
      });
    }
    await finalizeFromTransaction(transaction, {
      logger,
      captureWriter,
      studioEvents,
      codexVersionMonitor,
      route,
      compactionMode: classification.compactionMode,
      compactionDetectionSource: classification.detectionSource,
      req,
      url,
      startedAt,
      startedAtIso,
      upstream,
      requestId,
      persistBody: config.logging.persist_body
    });
  }
}

/**
 * Picks the upstream->Responses body transform for a plan. `nativeCompaction`
 * selects the compaction variant on the Anthropic path (the caller decides which
 * compaction mode counts as native). `transaction` is read lazily inside the
 * returned factory so the stream flag reflects the request at response time.
 */
function pickResponseTransform(
  plan: Pick<OpenAiProxyPlan, "upstreamProtocol" | "compactionFallback">,
  nativeCompaction: boolean,
  transaction: OpenAiProxyTransactionState
): ((status: number, headers: IncomingHttpHeaders) => UpstreamResponseTransform | null) | undefined {
  if (plan.upstreamProtocol === "anthropic_messages") {
    return nativeCompaction
      ? createAnthropicToResponsesCompactionResponseTransform
      : createAnthropicToResponsesResponseTransform;
  }
  if (plan.compactionFallback === "chat_synthesis") {
    return (status, headers) => createChatToResponsesCompactionResponseTransform(
      status,
      headers,
      transaction.requestType === "stream"
    );
  }
  return plan.upstreamProtocol === "openai_chat" ? createChatToResponsesResponseTransform : undefined;
}

/**
 * Records the stream outcome for a completed upstream result and returns the
 * client-facing view of it. A transformed response is classified with the
 * client-side stream summary; an untransformed one is classified against the
 * protocol actually spoken upstream.
 */
function applyClientResult(
  transaction: OpenAiProxyTransactionState,
  result: BufferedUpstreamResult,
  plan: Pick<OpenAiProxyPlan, "upstreamProtocol">
): { responseWasTransformed: boolean; clientResult: BufferedUpstreamResult } {
  const responseWasTransformed = result.clientResponseHeaders !== null &&
    result.clientResponseHeaders !== undefined;
  const clientResult = responseWasTransformed
    ? { ...result, streamSummary: result.clientStreamSummary ?? null }
    : result;
  transaction.streamOutcome = responseWasTransformed
    ? classifyOpenAiUpstreamResult(clientResult)
    : plan.upstreamProtocol === "anthropic_messages"
      ? classifyAnthropicUpstreamResult(result)
      : classifyOpenAiUpstreamResult(result);
  return { responseWasTransformed, clientResult };
}

function compactionResponseHeaders(
  classification: OpenAiRequestClassification
): Record<string, string> {
  return classification.route === "compact"
    ? { "x-compactgate-compaction-mode": classification.compactionMode }
    : {};
}

function requestProfileResponseHeaders(
  requestProfile: RequestScopedProfile | null
): Record<string, string> {
  return requestProfile
    ? {
        "x-compactgate-profile": requestProfile.profileId,
        "x-compactgate-profile-source": requestProfile.source
      }
    : {};
}

function applyCachedCompactResponse(
  transaction: ReturnType<typeof createOpenAiProxyTransactionState>,
  cached: CachedCompactResponse
): void {
  transaction.status = cached.status;
  transaction.upstreamStatus = cached.status;
  transaction.streamOutcome = cached.status >= 400 ? "upstream_http_error" : "success";
  transaction.responseBody = cached.responseBody;
  transaction.responseBodyTruncated = false;
  transaction.responseHeaders = cached.responseHeaders;
  transaction.clientResponseBody = cached.clientResponseBody;
  transaction.clientResponseHeaders = cached.clientResponseHeaders;
  transaction.compactResponseNormalized = cached.compactResponseNormalized;
  transaction.compactResponseNormalizeReason = cached.compactResponseNormalizeReason;
  transaction.compactResponseSyntheticSource = cached.compactResponseSyntheticSource;
  transaction.firstTokenMs = cached.firstTokenMs;
}
