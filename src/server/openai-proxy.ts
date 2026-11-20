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
import { ConfigError, ConfigRevisionError, type ConfigStore } from "./config.js";
import { FileCommitError } from "./config-file-repository.js";
import { credentialCandidateId, DIRECT_API_KEY_ID, enabledApiKeyPool } from "./credentials.js";
import { codexPrimaryCandidates } from "./primary-failover-candidates.js";
import type { OAuthProviderId } from "../shared/oauth.js";
import { prepareOAuthRequest } from "./oauth-transport.js";
import { waitForRequestPreparation } from "./request-preparation.js";
import { createCodexResponseTransform } from "./oauth-response.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import {
  endpointFromPath,
  parseJsonRecord,
  RequestBodyTooLargeError,
  readHeaderString,
  readRawBody,
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
  sendTransactionJson,
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
  emptyUsageMetrics,
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
import { ProtocolConversionError, UnsupportedClientProtocolError } from "./protocol-conversion.js";
import { DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES, MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES } from "./upstream-response-buffer.js";
import {
  createAnthropicToResponsesCompactionResponseTransform,
  createAnthropicToResponsesResponseTransform,
  createChatToResponsesCompactionResponseTransform,
  createChatToResponsesResponseTransform
} from "./protocol-stream.js";
import {
  analyzeProviderState,
  ProviderStateRecoveryUnavailableError,
  type CompileProviderStateOptions,
  type ProviderStateFidelity,
  type ProviderStateAnalysis
} from "./provider-state-portability.js";
import {
  runProviderStateMigration,
  type ProviderStateRecoveryTrigger,
  type ProviderStateMigrationResult
} from "./provider-state-migration.js";
import {
  providerStateBindingIdentityHashes,
  providerStateConversationHash
} from "./provider-state-binding.js";
import {
  hashStateDomain,
  stateDomainForPrimary
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
import type { ClientIdentityStore } from "./client-identity-store.js";
import { isNativeCodexUserAgent } from "./client-identity.js";
import { mergeUsage } from "./usage-merge.js";
import { rememberProviderCheckpoint, restoreProviderCheckpoint, recoveryPlanKey } from "./provider-state-checkpoints.js";
import { createOpenAiStreamObserver } from "./upstream-openai-stream.js";
import { recoveryHash, type ProviderStateRecoveryPolicy } from "./provider-state-recovery-store.js";

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
  codexVersionMonitor: CodexVersionMonitor,
  clientIdentity: ClientIdentityStore
): Promise<void> {
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  // Observed here rather than inside the plan builders: those also run for the
  // capability probe, which supplies synthesized headers that would poison the
  // extracted UA with a value no real client ever sent.
  observeCodexCliUserAgent(clientIdentity, readHeaderString(req.headers["user-agent"]));
  const baseConfig = configStore.get();
  const checkpointGeneration = logger.providerStateRecovery.checkpointGeneration;
  const requestProfile = resolveRequestScopedProfile(
    baseConfig,
    "codex",
    req.headers,
    req.socket.remoteAddress
  );
  const config = requestProfile?.config ?? baseConfig;
  const classification = classifyOpenAiRequest(url.pathname);
  const requestId = randomUUID();

  const pendingSyncs: Promise<void>[] = [];
  try {
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
        clientIdentity,
        requestId,
        startedAtIso,
        startedAt,
        classification,
        checkpointGeneration,
        requestProfile,
        pendingSyncs
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
      clientIdentity,
      requestId,
      startedAtIso,
      startedAt,
      checkpointGeneration,
      requestProfile,
      pendingSyncs
    );
  } finally {
    // Keep request ownership until timed-out profile commits and their notifications finish.
    await Promise.all(pendingSyncs);
  }
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
  clientIdentity: ClientIdentityStore,
  requestId: string,
  startedAtIso: string,
  startedAt: number,
  checkpointGeneration: number | null,
  requestProfile: RequestScopedProfile | null,
  pendingSyncs: Promise<void>[]
): Promise<void> {
  let route: RouteKind = "primary";
  let classification: OpenAiRequestClassification = {
    route: "primary",
    compactionMode: null,
    detectionSource: null
  };
  let delegatedToCompact = false;
  let attemptedUpstream = false;
  const modelList = req.method === "GET" && endpointFromPath(url.pathname) === "/models";
  const trackPrimarySelection = !requestProfile && !modelList;
  const sendUpstream: typeof sendOpenAiUpstreamRequest = (options) => {
    return sendOpenAiUpstreamRequest({ ...options, requireCompleteJsonResponse: true,
      rejectHtmlResponse: modelList ||
        options.req.method === "POST" && ["/responses", "/chat/completions"].includes(transaction.requestMetadata?.endpoint ?? ""),
      maxObservedStreamEventBytes: DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES, onAttemptStarted: () => {
      if (!attemptedUpstream) {
        studioEvents.broadcastKeyActivity("codex", primarySelection?.profileId ?? null,
          primarySelection?.keyId ?? enabledApiKeyPool(primarySelection?.config.primary ?? config.primary)[0]?.id ?? null,
          configRevision);
      }
      attemptedUpstream = true;
    } });
  };
  let primarySelection: PrimaryRouteSelection | null = null;
  let upstream = new URL(config.primary.base_url);
  let configRevision = configStore.revision;
  let providerStatePortability: ProviderStatePortabilityLog | null = null;
  const transaction = createOpenAiProxyTransactionState();

  try {
    // /responses can only be classified as local compact after its body arrives.
    transaction.rawBody = await waitForRequestPreparation(signal => readRawBody(req, undefined, signal), {
      req, res, startedAt, timeoutMessage: "Primary request timed out while reading its body.",
      timeoutMs: req.method === "POST" && endpointFromPath(url.pathname) === "/responses"
        ? Math.max(config.timeouts.primary_ms, config.timeouts.compact_ms) : config.timeouts.primary_ms
    });
    // A slow body must not reconcile shared health back to an obsolete config.
    // Explicit profiles keep their isolated snapshot and never mutate that state.
    if (!requestProfile) {
      config = configStore.get();
      configRevision = configStore.revision;
    }
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
        clientIdentity,
        requestId,
        startedAtIso,
        startedAt,
        classification,
        checkpointGeneration,
        requestProfile,
        pendingSyncs,
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
    const inMemorySourceCandidateId = requestProfile
      ? null
      : primaryFailover.boundProfileId(primaryRequestContext);
    const candidates = requestProfile ? [] : codexPrimaryCandidates(config);
    const conversationIdentityHash = providerStateConversationHash(primaryRequestContext);
    const explicitPool = requestProfile ? enabledApiKeyPool(config.primary) : [];
    const explicitKey = explicitPool.length === 1 && explicitPool[0].id === DIRECT_API_KEY_ID ? undefined : explicitPool[0];
    const primarySelectionOverride: PrimaryRouteSelection = requestProfile
      ? {
          config,
          profileId: requestProfile.profileId,
          keyId: explicitKey?.id ?? null,
          keyLabel: explicitKey?.label || null,
          candidateId: credentialCandidateId(requestProfile.profileId, explicitKey?.id ?? null),
          profileName: requestProfile.profileName,
          generation: 0,
          healthVersion: 0,
          context: normalizeRequestContext(primaryRequestContext)
        }
      : primaryFailover.preview(config, primaryRequestContext, candidates);

    const plan = buildPrimaryOpenAiProxyPlan({
      config,
      url,
      headers: req.headers,
      rawBody: transaction.rawBody,
      endpoint: transaction.requestMetadata.endpoint,
      method: req.method,
      compactionBridge,
      primaryFailover,
      preserveRemoteV2State: hasRemoteV2CompactionState(url.pathname, transaction.rawBody, req.headers),
      primarySelectionOverride,
      reservePrimarySelection: trackPrimarySelection,
      synthesizeRemoteV2Compaction: classification.route === "compact" &&
        classification.compactionMode === "remote_v2",
      clientIdentity,
      restoreCompaction: conversationIdentityHash ? body => restoreProviderCheckpoint(
        logger.providerStateRecovery, conversationIdentityHash, body, config.primary_failover.state_recovery_retention_hours ?? 0
      ) : undefined
    });
    route = classification.route;
    upstream = plan.upstream;
    primarySelection = plan.primarySelection;
    const oauthProvider = await prepareOAuthRequest(
      primarySelection?.config.primary ?? config.primary, configStore.oauth, plan, req.method,
      { req, res, startedAt, timeoutMs: plan.timeoutMs, timeoutMessage: plan.timeoutMessage }
    );
    if (res.destroyed) throw new ConfigError("Client disconnected during OAuth preparation.", 499);
    if (trackPrimarySelection) {
      await waitForRequestPreparation(() => {
        const sync = syncScheduledPrimaryProfile({
          configRevision,
          configStore,
          logger,
          primarySelection,
          studioEvents,
          codexVersionMonitor,
          clientIdentity
        });
        pendingSyncs.push(sync);
        return sync;
      }, { req, res, startedAt, timeoutMs: plan.timeoutMs, timeoutMessage: plan.timeoutMessage });
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
      "x-compactgate-request-id": requestId,
      ...(plan.recoveredContextFidelity ? {
        "x-compactgate-state-recovery": "recovered", "x-compactgate-context-fidelity": plan.recoveredContextFidelity
      } : {})
    };
    const bindingIdentityHashes = providerStateBindingIdentityHashes(primaryRequestContext);
    const persistedBinding = logger.findProviderStateBinding(bindingIdentityHashes);
    const inMemorySourceCandidate = !persistedBinding && inMemorySourceCandidateId
      ? candidates.find(candidate => candidate.id === inMemorySourceCandidateId)
      : undefined;
    const sourceProfileId = persistedBinding?.profileId ?? inMemorySourceCandidate?.profileId ?? null;
    const sourceStateDomain = persistedBinding?.stateDomainId ??
      (inMemorySourceCandidate ? stateDomainForPrimary(inMemorySourceCandidate.primary,
        inMemorySourceCandidate.profileId, inMemorySourceCandidate.keyId) : null);
    const targetStateDomain = primarySelection
      ? stateDomainForPrimary(
          primarySelection.config.primary,
          primarySelection.profileId,
          primarySelection.keyId
        )
      : stateDomainForPrimary(config.primary);
    const stateAnalysis = analyzeProviderState(transaction.upstreamBody);
    const targetScope: ProviderStateTargetScope = {
      targetStateDomain,
      model: transaction.targetModel,
      endpoint: transaction.requestMetadata.endpoint
    };
    const targetHealthKey = providerStateTargetHealthKey(targetScope);
    const targetStateFreeSuccess = logger.hasProviderStateRecoveryEvidence(targetHealthKey);
    const recoveryEnabled = plan.translateResponses && config.primary_failover.state_portability === "recover_on_error" &&
      plan.upstreamProtocol === "openai_responses";
    const retentionHours = config.primary_failover.state_recovery_retention_hours ?? 0;
    const recoveryStore = logger.providerStateRecovery;
    const attemptRecovery = recoveryEnabled && stateAnalysis.hasProviderOwnedState;
    let recoveryKey: string | null = null;
    if (attemptRecovery && conversationIdentityHash) {
      const resourceHeaders = new Set(["authorization", "api-key", "x-api-key", "openai-project", "openai-organization", "chatgpt-account-id",
        ...plan.sensitiveHeaderNames.map(name => name.toLowerCase())]);
      const headerIdentity = Object.entries(transaction.requestHeaders)
        .filter(([name]) => resourceHeaders.has(name.toLowerCase()) && !(oauthProvider && name.toLowerCase() === "authorization"))
        .sort(([left], [right]) => left.localeCompare(right));
      recoveryKey = recoveryPlanKey(recoveryHash(
        conversationIdentityHash, targetStateDomain, upstream.toString(), transaction.targetModel ?? "",
        JSON.stringify(headerIdentity), plan.proxyUrl,
        (primarySelection?.config.primary ?? config.primary).oauth_account_id ?? ""
      ), transaction.upstreamBody);
    }
    const recoverCompaction: CompileProviderStateOptions["recoverCompaction"] = conversationIdentityHash
      ? body => restoreProviderCheckpoint(recoveryStore, conversationIdentityHash, body, retentionHours) : undefined;
    const recovery = attemptRecovery
      ? await sendRecoveringResponsesRequest({
          send: sendUpstream,
          req,
          res,
          upstream,
          startedAt,
          timeoutMs: plan.timeoutMs,
          timeoutMessage: plan.timeoutMessage,
          requestHeaders: transaction.requestHeaders,
          proxyUrl: plan.proxyUrl,
          canonicalBody: transaction.upstreamBody,
          canonicalFidelity: plan.recoveredContextFidelity,
          extraResponseHeaders,
          targetStateDomain,
          recoverCompaction,
          cachedPolicy: recoveryKey ? recoveryStore.findPolicy(recoveryKey) : null,
          responseTransform: pickResponseTransform(plan, false, transaction, oauthProvider),
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
            const conversationHash = conversationIdentityHash;
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
    const result = recovery?.result ?? await sendUpstream({
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
      retryEmptyStreamError: classification.route !== "compact" &&
        plan.translateResponses &&
        plan.upstreamProtocol === "openai_responses" &&
        transaction.requestType === "stream",
      retryHttpStatuses: classification.route === "compact" ? [502, 503, 504] : undefined,
      maxHttpStatusRetries: classification.route === "compact" ? 3 : 0,
      streamProtocol: plan.upstreamProtocol === "anthropic_messages" ? "anthropic" : "openai",
      responseTransform: pickResponseTransform(
        plan,
        classification.compactionMode === "remote_v2",
        transaction,
        oauthProvider
      )
    });

    applyOpenAiProxyUpstreamResult(transaction, result);
    applyClientResult(transaction, result, plan, transaction.requestMetadata.requestType === "stream");
    const clientResponseHeaders = result.clientResponseHeaders ?? transaction.responseHeaders;
    transaction.requestType = responseTransport(clientResponseHeaders) ?? transaction.requestType;
    providerStatePortability = buildProviderStatePortabilityLog({
      enabled: recoveryEnabled,
      conversationHash: conversationIdentityHash,
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
    if (recoveryKey && recovery?.policy && recovery.trigger && completedSuccessfully) {
      recoveryStore.rememberPolicy(recoveryKey, recovery.policy, Math.round((performance.timeOrigin + startedAt) * 1_000));
    }
    if (completedSuccessfully && plan.translateResponses) {
      rememberProviderCheckpoint({ store: recoveryStore, checkpointGeneration, conversationHash: conversationIdentityHash, retentionHours,
        requestBody: plan.responsesRequestBody ?? transaction.upstreamBody,
        requestFidelity: recovery?.attempts.at(-1)?.compiled.fidelity ?? plan.recoveredContextFidelity,
        result, mode: "remote_v2", upstreamProtocol: plan.upstreamProtocol });
    }
    if (completedSuccessfully && !modelList && !stateAnalysis.hasProviderOwnedState) {
      logger.rememberProviderStateRecoveryEvidence(
        targetHealthKey,
        "target_health",
        PROVIDER_STATE_TARGET_HEALTH_TTL_MS
      );
    }
    if (
      primarySelection?.profileId &&
      completedSuccessfully && !modelList
    ) {
      const responseId = readResponseId({
        responseId: transaction.responseId,
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
    // Once the compact path has taken the request it owns the response and its own
    // logging, so a throw arriving from inside it must not be answered again here:
    // writing a second body onto that stream corrupts what the client already
    // received. Rethrowing keeps the failure visible to the server's own handler.
    if (delegatedToCompact) {
      throw error;
    }
    if (error instanceof UpstreamRequestError) {
      applyUpstreamFailureToTransaction(transaction, error.details);
    }
    transaction.status = error instanceof ProviderStateRecoveryUnavailableError ? error.status : error instanceof ConfigError ? error.status ?? 400 : error instanceof ProtocolConversionError
      ? error.status
      : error instanceof RequestBodyTooLargeError
      ? 413
      : error instanceof UnresolvedCompactionStateError
        ? 422
        : 502;
    transaction.errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendTransactionJson(transaction, res, {
        error: error instanceof ProviderStateRecoveryUnavailableError
          ? { type: "invalid_request_error", code: error.code, message: transaction.errorSummary }
          : error instanceof UnsupportedClientProtocolError
          ? { type: "invalid_request_error", code: "unsupported_protocol", message: transaction.errorSummary }
          : transaction.errorSummary,
        request_id: requestId
      });
    } else {
      res.destroy(error instanceof Error ? error : new Error(transaction.errorSummary));
    }
  } finally {
    // Guarded rather than returned from: a `return` inside `finally` discards any
    // exception still propagating out of the try or the catch, so the delegation
    // check used to swallow whatever the compact path had thrown.
    if (!delegatedToCompact) {
    if (primarySelection && trackPrimarySelection) {
      primaryFailover.recordResult(primarySelection, attemptedUpstream ? {
        responseId: transaction.responseId,
        status: transaction.status,
        errorSummary: transaction.errorSummary,
        streamOutcome: transaction.streamOutcome,
        responseBody: transaction.responseBody,
        responseHeaders: transaction.responseHeaders,
        firstTokenMs: transaction.firstTokenMs,
        usage: transaction.usage
      } : null);
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
        persistBody: config.logging.persist_body,
        keyName: primarySelection?.keyLabel ?? primarySelection?.profileName ?? null
      });
    }
  }
}

async function sendRecoveringResponsesRequest(input: {
  send: typeof sendOpenAiUpstreamRequest;
  req: IncomingMessage;
  res: ServerResponse;
  upstream: URL;
  startedAt: number;
  timeoutMs: number;
  timeoutMessage: string;
  requestHeaders: Record<string, string>;
  proxyUrl: string;
  canonicalBody: Buffer;
  canonicalFidelity?: ProviderStateFidelity;
  extraResponseHeaders: Record<string, string>;
  targetStateDomain: string;
  recoverCompaction?: CompileProviderStateOptions["recoverCompaction"];
  cachedPolicy?: ProviderStateRecoveryPolicy | null;
  responseTransform?: (status: number, headers: IncomingHttpHeaders) => UpstreamResponseTransform | null;
  startGenericRecovery: (
    result: Awaited<ReturnType<typeof sendOpenAiUpstreamRequest>>,
    afterErrorSpecificRepair: boolean
  ) => Exclude<ProviderStateRecoveryTrigger, "explicit_400"> | null;
}): Promise<ProviderStateMigrationResult> {
  const recovery = await runProviderStateMigration({
    canonicalBody: input.canonicalBody,
    canonicalFidelity: input.canonicalFidelity,
    targetStateDomain: input.targetStateDomain,
    recoverCompaction: input.recoverCompaction,
    cachedPolicy: input.cachedPolicy,
    canReplay: () =>
      !input.res.headersSent &&
      !input.res.writableEnded &&
      !input.res.destroyed &&
      performance.now() - input.startedAt < input.timeoutMs,
    startGenericRecovery: input.startGenericRecovery,
    send: (body, strategy, priorStrategy, compiled, recoverySource) => input.send({
      req: input.req,
      res: input.res,
      upstream: input.upstream,
      startedAt: input.startedAt,
      timeoutMs: input.timeoutMs,
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
      extraResponseHeaders: {
        ...input.extraResponseHeaders,
        ...(recoverySource ? {
          "x-compactgate-state-recovery": recoverySource,
          "x-compactgate-context-fidelity": compiled.fidelity
        } : {})
      },
      deferHttpErrors: true,
      deferProviderStateStreamErrors: true,
      responseTransform: input.responseTransform
    })
  });
  if (recovery.result.status >= 400 || recovery.result.deferredProviderStateFailure) {
    writeBufferedUpstreamResult(input.res, recovery.result, { ...input.extraResponseHeaders,
      ...(recovery.unavailable ? { "x-compactgate-state-recovery": "unavailable" } : {}) });
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
    ...(input.recovery?.unavailable ? { recovery_unavailable: true } : {}),
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
      encrypted_agent_messages: input.analysis.encryptedAgentMessageCount,
      encrypted_non_compaction_items: input.analysis.encryptedNonCompactionItemCount,
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

/**
 * Feeds a real Codex CLI request's UA into the extracted source. Only a native
 * CLI qualifies — recording a third-party client would make the proxy impersonate
 * whatever last called it, and once rewriting is on it would then re-record its
 * own synthesized value.
 */
function observeCodexCliUserAgent(
  clientIdentity: ClientIdentityStore,
  userAgent: string | null
): void {
  if (isNativeCodexUserAgent(userAgent)) {
    clientIdentity.observeCliUserAgent("codex", userAgent);
  }
}

async function syncScheduledPrimaryProfile({
  configRevision,
  configStore,
  logger,
  primarySelection,
  studioEvents,
  codexVersionMonitor,
  clientIdentity
}: {
  configRevision: string;
  configStore: ConfigStore;
  logger: RequestLogger;
  primarySelection: PrimaryRouteSelection | null;
  studioEvents: StudioEventBroadcaster;
  codexVersionMonitor: CodexVersionMonitor;
  clientIdentity: ClientIdentityStore;
}): Promise<void> {
  const selectedProfileId = primarySelection?.profileId;
  if (!selectedProfileId) {
    return;
  }

  // Other writes may have landed while this request prepared its upstream.
  // This live check avoids unnecessary work; the queued revision check below
  // is authoritative for writes that have started but not committed yet.
  const current = configStore.get();
  if (
    !current.primary_failover.auto_schedule ||
    selectedProfileId === (current.profile_scopes?.codex?.active_profile_id ?? null)
  ) {
    return;
  }

  // Something wrote the config after this request took its snapshot — an
  // operator applying a profile in Studio, or another request's own sync. That
  // decision is newer than this selection, so leave it alone instead of
  // reverting an explicit choice (and rotating a backup slot to do it).
  if (configStore.revision !== configRevision) {
    return;
  }

  let committed = false;
  try {
    await configStore.applyProfile("codex", selectedProfileId, configRevision);
    committed = true;
  } catch (error) {
    // The chosen upstream remains valid for this request. A newer global
    // choice only makes its automatic synchronization obsolete.
    if (error instanceof ConfigRevisionError) return;
    committed = error instanceof FileCommitError && error.filePath === configStore.getConfigPath();
    throw error;
  } finally {
    if (committed) studioEvents.broadcastSnapshot(
      createStudioSnapshot(configStore, logger, codexVersionMonitor, clientIdentity)
    );
  }
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
  clientIdentity: ClientIdentityStore,
  requestId: string,
  startedAtIso: string,
  startedAt: number,
  classification: Extract<OpenAiRequestClassification, { route: "compact" }>,
  checkpointGeneration: number | null,
  requestProfile: RequestScopedProfile | null,
  pendingSyncs: Promise<void>[],
  prepared?: {
    rawBody: Buffer;
    requestMetadata: RequestMetadata;
  }
): Promise<void> {
  const route: RouteKind = "compact";
  let compactResponseItemCount: number | undefined;
  let configRevision = configStore.revision;
  let upstream = new URL(config.compact.base_url);
  let attemptedUpstream = false;
  // Public error status distinguishes preparation from transport, including preflight.
  let invokedTransport = false;
  let primarySelection: PrimaryRouteSelection | null = null;
  let providerStatePortability: ProviderStatePortabilityLog | null = null;
  const transaction = createOpenAiProxyTransactionState();

  try {
    transaction.rawBody = prepared?.rawBody ?? await waitForRequestPreparation(signal => readRawBody(req, undefined, signal), {
      req, res, startedAt, timeoutMs: config.timeouts.compact_ms, timeoutMessage: "Compact request timed out while reading its body."
    });
    // Covers both direct /compact requests and primary's local-compact handoff.
    if (!requestProfile) {
      config = configStore.get();
      configRevision = configStore.revision;
    }
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
      nativeCompaction: classification.compactionMode === "remote_v1",
      clientIdentity
    });
    if (selectedPrimary) {
      primaryFailover.reserveSelection(selectedPrimary, config.primary_failover.auto_schedule);
      primarySelection = selectedPrimary;
      await waitForRequestPreparation(() => {
        const sync = syncScheduledPrimaryProfile({
          configRevision,
          configStore,
          logger,
          primarySelection,
          studioEvents,
          codexVersionMonitor,
          clientIdentity
        });
        pendingSyncs.push(sync);
        return sync;
      }, { req, res, startedAt, timeoutMs: plan.timeoutMs, timeoutMessage: plan.timeoutMessage });
    }
    upstream = plan.upstream;
    const selectedConfig = selectedPrimary?.config ?? config;
    const oauthProvider = await prepareOAuthRequest(
      selectedConfig.compact.upstream_mode === "primary" ? selectedConfig.primary : selectedConfig.compact,
      configStore.oauth, plan, req.method,
      { req, res, startedAt, timeoutMs: plan.timeoutMs, timeoutMessage: plan.timeoutMessage }
    );
    if (res.destroyed) throw new ConfigError("Client disconnected during OAuth preparation.", 499);
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
      compactResponseItemCount = cachedCompactResponse.compactResponseItemCount;
      if ((config.primary_failover.state_recovery_retention_hours ?? 0) > 0) {
        const observer = createOpenAiStreamObserver(cachedCompactResponse.responseHeaders);
        observer?.observe(cachedCompactResponse.responseBody);
        rememberProviderCheckpoint({ store: logger.providerStateRecovery, checkpointGeneration,
          conversationHash: providerStateConversationHash(primaryRouteRequestContextFromBody(transaction.rawBody, req.headers)),
          retentionHours: config.primary_failover.state_recovery_retention_hours ?? 0,
          requestBody: transaction.upstreamBody, mode: "remote_v1", result: {
            ...cachedCompactResponse, errorSummary: null, responseBodyTruncated: false,
            streamSummary: await observer?.finish() ?? null, clientDisconnectPhase: res.destroyed ? "before_terminal" : "none"
          } });
      }
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
    invokedTransport = true;

    const extraResponseHeaders = {
      "x-compactgate-route": route,
      ...compactionResponseHeaders(classification),
      ...requestProfileResponseHeaders(requestProfile),
      "x-compactgate-model": transaction.targetModel ?? "",
      "x-compactgate-request-id": requestId
    };
    const conversationHash = providerStateConversationHash(primaryRouteRequestContextFromBody(transaction.rawBody, req.headers));
    const targetStateDomain = selectedConfig.compact.upstream_mode === "primary"
      ? stateDomainForPrimary(selectedConfig.primary, primarySelection?.profileId ?? requestProfile?.profileId, primarySelection?.keyId)
      : upstream.origin;
    const stateAnalysis = analyzeProviderState(transaction.upstreamBody);
    const recoveryEnabled = config.primary_failover.state_portability === "recover_on_error" && plan.upstreamProtocol === "openai_responses";
    let statusRetriesRemaining = 3;

    // 方案 B:流式转发原始上游 SSE 流给客户端。Codex compact 用 collect_compaction_output 逐事件消费,
    // 需要 response.created / response.output_item.done / response.completed 事件;缓冲后转 JSON 会让客户端
    // 长时间收不到任何字节而断开(Client disconnected before upstream response completed)。
    // 完整响应同时缓冲在 transaction.responseBody,供归一化、桥接存储与 dedupe 重放使用。
    const sendCompact: typeof sendOpenAiUpstreamRequest = options => {
      let attempts = 0;
      return sendOpenAiUpstreamRequest({
        ...options,
        onAttemptStarted: () => {
          if (attempts++ > 0) statusRetriesRemaining--;
          if (!attemptedUpstream && selectedConfig.compact.upstream_mode === "primary") {
            studioEvents.broadcastKeyActivity("codex", primarySelection?.profileId ?? requestProfile?.profileId ?? null,
              primarySelection?.keyId ?? enabledApiKeyPool(selectedConfig.primary)[0]?.id ?? null, configRevision);
          }
          attemptedUpstream = true;
        },
        maxBufferedResponseBytes: classification.compactionMode === "remote_v1" ? MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES : undefined,
        requireCompleteResponse: classification.compactionMode === "remote_v1",
        requireCompleteJsonResponse: true,
        maxObservedStreamEventBytes: DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES,
        retryHttpStatuses: [502, 503, 504],
        maxHttpStatusRetries: statusRetriesRemaining,
        streamProtocol: plan.upstreamProtocol === "anthropic_messages" ? "anthropic" : "openai",
        responseTransform: pickResponseTransform(
          plan,
          classification.compactionMode === "remote_v1",
          transaction,
          oauthProvider
        )
      });
    };
    const sendOptions = { req, res, upstream, startedAt, timeoutMs: plan.timeoutMs, timeoutMessage: plan.timeoutMessage,
      requestHeaders: transaction.requestHeaders, proxyUrl: plan.proxyUrl, extraResponseHeaders };
    const recovery = recoveryEnabled && stateAnalysis.hasProviderOwnedState
      ? await sendRecoveringResponsesRequest({ ...sendOptions, send: sendCompact,
          canonicalBody: transaction.upstreamBody, targetStateDomain,
          recoverCompaction: conversationHash ? body => restoreProviderCheckpoint(logger.providerStateRecovery,
            conversationHash, body, config.primary_failover.state_recovery_retention_hours ?? 0) : undefined,
          startGenericRecovery: () => null
        }) : null;
    if (recovery) {
      transaction.requestHeaders = requestHeadersForCompiledBody(transaction.requestHeaders, transaction.upstreamBody, recovery.body, false);
      transaction.upstreamBody = recovery.body;
    }
    const result = recovery?.result ?? await sendCompact({ ...sendOptions, body: transaction.upstreamBody });
    providerStatePortability = buildProviderStatePortabilityLog({ enabled: recoveryEnabled, conversationHash,
      sourceProfileId: null, targetProfileId: primarySelection?.profileId ?? requestProfile?.profileId ?? null,
      sourceStateDomain: null, targetStateDomain, targetStateFreeSuccess: false, analysis: stateAnalysis, recovery });

    applyOpenAiProxyUpstreamResult(transaction, result);
    applyClientResult(transaction, result, plan);
    if (classification.compactionMode === "remote_v1" && plan.upstreamProtocol === "openai_responses" &&
      transaction.streamOutcome === "success" && !transaction.errorSummary) {
      rememberProviderCheckpoint({ store: logger.providerStateRecovery, checkpointGeneration,
        conversationHash: providerStateConversationHash(primaryRouteRequestContextFromBody(transaction.rawBody, req.headers)),
        retentionHours: config.primary_failover.state_recovery_retention_hours ?? 0,
        requestBody: transaction.upstreamBody, requestFidelity: recovery?.attempts.at(-1)?.compiled.fidelity, result, mode: "remote_v1" });
    }
    const clientResponseBody = result.clientResponseBody ?? transaction.responseBody;
    const clientResponseHeaders = result.clientResponseHeaders ?? transaction.responseHeaders;
    // 远程压缩归一化仅用于桥接存储和诊断日志,不写回客户端。本地摘要压缩返回普通
    // Responses 流,不能把它误记为缺失 compaction output。
    const unnormalizedResponse = {
      normalized: false,
      reason: null,
      syntheticSource: null,
      bridgeOutput: clientResponseBody,
      responseItemCount: undefined
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
    if (!result.clientResponseHeaders) compactResponseItemCount = normalizedResponse.responseItemCount;
    transaction.requestType = responseTransport(clientResponseHeaders) ?? transaction.requestType;
    if (
      transaction.status >= 200 &&
      transaction.status < 300 &&
      transaction.streamOutcome === "success" &&
      !transaction.errorSummary &&
      plan.compactBridgeScope
    ) {
      if (classification.compactionMode === "remote_v1") {
        compactionBridge.storeCompactResponse(normalizedResponse.bridgeOutput, {
          scope: plan.compactBridgeScope,
          source: normalizedResponse.normalized ? "synthetic" : "standard"
        });
        // The wire cache cannot replay a response whose client protocol was transformed.
        if (canDedupeCompactResponse && !result.clientResponseHeaders && !recovery?.trigger) {
          compactionBridge.storeCompactDedupeResponse(dedupeInput, {
            status: transaction.status,
            responseBody: transaction.responseBody,
            responseHeaders: transaction.responseHeaders,
            compactResponseNormalized: transaction.compactResponseNormalized,
            compactResponseNormalizeReason: transaction.compactResponseNormalizeReason,
            compactResponseSyntheticSource: transaction.compactResponseSyntheticSource,
            compactResponseItemCount: normalizedResponse.responseItemCount,
            firstTokenMs: transaction.firstTokenMs
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof UpstreamRequestError) {
      applyUpstreamFailureToTransaction(transaction, error.details);
    }
    transaction.status = error instanceof ConfigError ? error.status ?? 400 : error instanceof ProtocolConversionError
      ? error.status
      : error instanceof RequestBodyTooLargeError
        ? 413
        : invokedTransport || error instanceof UpstreamRequestError
          ? 502
          : 400;
    transaction.errorSummary = summaryForError(error);

    if (!transaction.sourceModel && transaction.rawBody.byteLength > 0) {
      const parsedBody = parseJsonRecord(transaction.rawBody);
      transaction.sourceModel = typeof parsedBody?.model === "string" ? parsedBody.model : null;
    }

    if (!res.headersSent) {
      sendTransactionJson(transaction, res, { error: transaction.errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(transaction.errorSummary));
    }
  } finally {
    if (primarySelection && !requestProfile) {
      primaryFailover.recordResult(primarySelection, attemptedUpstream ? {
        status: transaction.status,
        errorSummary: transaction.errorSummary,
        streamOutcome: transaction.streamOutcome,
        responseBody: transaction.responseBody,
        responseHeaders: transaction.responseHeaders,
        firstTokenMs: transaction.firstTokenMs,
        usage: transaction.usage
      } : null);
    }
    await finalizeFromTransaction(transaction, {
      logger,
      captureWriter,
      studioEvents,
      codexVersionMonitor,
      route,
      compactionMode: classification.compactionMode,
      compactResponseItemCount,
      compactionDetectionSource: classification.detectionSource,
      req,
      url,
      startedAt,
      startedAtIso,
      upstream,
      requestId,
      providerStatePortability,
      persistBody: config.logging.persist_body,
      keyName: null
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
  plan: Pick<OpenAiProxyPlan, "upstreamProtocol" | "compactionFallback" | "translateResponses">,
  nativeCompaction: boolean,
  transaction: OpenAiProxyTransactionState,
  oauthProvider: OAuthProviderId | null = null
): ((status: number, headers: IncomingHttpHeaders) => UpstreamResponseTransform | null) | undefined {
  if (!plan.translateResponses) return undefined;
  if (oauthProvider === "openai-codex") {
    return (status, headers) => createCodexResponseTransform(status, headers, transaction.requestType === "stream");
  }
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
 * Derive diagnostics before the outcome so late stream failures also reach
 * failover. Explicit source failures already live in result.errorSummary; terminal
 * completeness here follows the translated client protocol.
 */
function applyClientResult(
  transaction: OpenAiProxyTransactionState,
  result: BufferedUpstreamResult,
  plan: Pick<OpenAiProxyPlan, "upstreamProtocol">,
  expectStream = false
): void {
  const responseWasTransformed = result.clientResponseHeaders !== null &&
    result.clientResponseHeaders !== undefined;
  const clientResult = responseWasTransformed
    ? { ...result, streamSummary: result.clientStreamSummary ?? null }
    : result;
  // A retained prefix is older than the incremental observation, not a final reading.
  const bodyTruncated = responseWasTransformed ? result.clientResponseBodyTruncated : result.responseBodyTruncated;
  const observedUsage = clientResult.streamSummary?.usage;
  transaction.usage = bodyTruncated
    ? observedUsage ?? emptyUsageMetrics()
    : mergeUsage(observedUsage ?? null, extractResponseUsage(
        result.clientResponseBody ?? result.responseBody, result.clientResponseHeaders ?? result.responseHeaders
      ));
  const anthropic = !responseWasTransformed && plan.upstreamProtocol === "anthropic_messages";
  if (clientResult.streamSummary || expectStream) {
    transaction.errorSummary ??= anthropic
      ? summarizeAnthropicStreamFailure(clientResult)
      : summarizeOpenAiStreamFailure(clientResult);
  }
  const classifiedResult = { ...clientResult, errorSummary: transaction.errorSummary };
  transaction.streamOutcome = anthropic
    ? classifyAnthropicUpstreamResult(classifiedResult)
    : classifyOpenAiUpstreamResult(classifiedResult);
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
  // Compact replays the original wire response; normalized content is only used when building the bridge.
  transaction.clientResponseBody = null;
  transaction.clientResponseHeaders = null;
  transaction.compactResponseNormalized = cached.compactResponseNormalized;
  transaction.compactResponseNormalizeReason = cached.compactResponseNormalizeReason;
  transaction.compactResponseSyntheticSource = cached.compactResponseSyntheticSource;
  // A replay has no new upstream response sample.
  transaction.firstTokenMs = null;
  transaction.generationSample = null;
}
