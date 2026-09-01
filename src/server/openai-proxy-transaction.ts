import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type {
  ClientDisconnectPhase,
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource,
  OpenAiCompactionMode,
  OpenAiRequestDetectionSource,
  ProviderStatePortabilityLog,
  RequestTransport,
  RouteKind,
  StreamOutcome
} from "../shared/types.js";
import type { OpenAiStreamSummary } from "./upstream-openai-stream.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import { serializeHeaders } from "./debug-capture.js";
import { endpointFromPath } from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import {
  addLog,
  emptyUsageMetrics,
  persistCapture,
  redactUrlForStorage,
  storedPathForUrl
} from "./proxy-support.js";
import { StudioEventBroadcaster } from "./studio-events.js";
import { CODEX_PROTOCOL_LOG_LIMIT } from "./codex-version.js";
import type { CodexVersionMonitor } from "./codex-version.js";
import type {
  RequestMetadata,
  TokenUsageMetrics
} from "./usage.js";
import { buildCompactionDiagnostics } from "./compaction-diagnostics.js";

export interface OpenAiProxyTransactionState {
  status: number;
  upstreamStatus: number | null;
  streamTerminalEvent: string | null;
  clientDisconnectPhase: ClientDisconnectPhase;
  streamOutcome: StreamOutcome | null;
  streamOversizedEventCount: number;
  responseBodyTruncated: boolean;
  errorSummary: string | null;
  rawBody: Buffer;
  upstreamBody: Buffer;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  clientResponseBody: Buffer | null;
  clientResponseHeaders: IncomingHttpHeaders | null;
  requestHeaders: Record<string, string>;
  requestMetadata: RequestMetadata | null;
  requestType: RequestTransport;
  firstTokenMs: number | null;
  usage: TokenUsageMetrics;
  sourceModel: string | null;
  targetModel: string | null;
  responseModel: string | null;
  compactBridgeReplacements: number;
  compactResponseNormalized: boolean;
  compactResponseNormalizeReason: CompactResponseNormalizeReason | null;
  compactResponseSyntheticSource: CompactResponseSyntheticSource | null;
  sensitiveHeaderNames: string[];
}

export interface OpenAiProxyUpstreamResult {
  status: number;
  errorSummary: string | null;
  responseBody: Buffer;
  responseBodyTruncated: boolean;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
  clientDisconnectPhase: ClientDisconnectPhase;
  streamSummary: OpenAiStreamSummary | null;
  clientStreamSummary?: OpenAiStreamSummary | null;
  clientResponseBody?: Buffer | null;
  clientResponseHeaders?: IncomingHttpHeaders | null;
}

export interface OpenAiProxyTransactionInput {
  logger: RequestLogger;
  captureWriter: DebugCaptureWriter;
  studioEvents: StudioEventBroadcaster;
  codexVersionMonitor?: CodexVersionMonitor;
  req: IncomingMessage;
  url: URL;
  route: RouteKind;
  compactionMode?: OpenAiCompactionMode | null;
  compactionDetectionSource?: OpenAiRequestDetectionSource | null;
  status: number;
  upstreamStatus?: number | null;
  streamTerminalEvent?: string | null;
  clientDisconnectPhase?: ClientDisconnectPhase;
  streamOutcome?: StreamOutcome | null;
  streamOversizedEventCount?: number;
  upstreamResponseTruncated?: boolean;
  startedAt: number;
  startedAtIso: string;
  requestMetadata: RequestMetadata | null;
  requestType: RequestTransport;
  upstream: URL;
  requestId: string;
  sourceModel: string | null;
  targetModel: string | null;
  responseModel?: string | null;
  firstTokenMs: number | null;
  usage: TokenUsageMetrics;
  errorSummary: string | null;
  providerStatePortability?: ProviderStatePortabilityLog | null;
  compactBridgeReplacements: number;
  rawBody: Buffer;
  requestHeaders: Record<string, string>;
  upstreamBody: Buffer;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  clientResponseBody: Buffer | null;
  clientResponseHeaders: IncomingHttpHeaders | null;
  persistBody: boolean;
  compactResponseNormalized: boolean;
  compactResponseNormalizeReason: CompactResponseNormalizeReason | null;
  compactResponseSyntheticSource: CompactResponseSyntheticSource | null;
  sensitiveHeaderNames?: string[];
}

export function createOpenAiProxyTransactionState(): OpenAiProxyTransactionState {
  return {
    status: 502,
    upstreamStatus: null,
    streamTerminalEvent: null,
    clientDisconnectPhase: "none",
    streamOutcome: null,
    streamOversizedEventCount: 0,
    responseBodyTruncated: false,
    errorSummary: null,
    rawBody: Buffer.alloc(0),
    upstreamBody: Buffer.alloc(0),
    responseBody: Buffer.alloc(0),
    responseHeaders: {},
    clientResponseBody: null,
    clientResponseHeaders: null,
    requestHeaders: {},
    requestMetadata: null,
    requestType: "http",
    firstTokenMs: null,
    usage: emptyUsageMetrics(),
    sourceModel: null,
    targetModel: null,
    responseModel: null,
    compactBridgeReplacements: 0,
    compactResponseNormalized: false,
    compactResponseNormalizeReason: null,
    compactResponseSyntheticSource: null,
    sensitiveHeaderNames: []
  };
}

export function applyOpenAiProxyUpstreamResult(
  state: OpenAiProxyTransactionState,
  result: OpenAiProxyUpstreamResult
): void {
  const streamSummary = result.clientStreamSummary ?? result.streamSummary;
  state.status = result.status;
  state.upstreamStatus = result.status;
  state.streamTerminalEvent = streamSummary?.terminalEvent ?? null;
  state.clientDisconnectPhase = result.clientDisconnectPhase;
  state.streamOversizedEventCount = streamSummary?.oversizedEventCount ?? 0;
  state.responseBodyTruncated = result.responseBodyTruncated;
  state.responseModel = streamSummary?.responseModel ?? state.responseModel;
  state.errorSummary = result.errorSummary;
  state.responseBody = result.responseBody;
  state.responseHeaders = result.responseHeaders;
  state.clientResponseBody = result.clientResponseBody ?? null;
  state.clientResponseHeaders = result.clientResponseHeaders ?? null;
  state.firstTokenMs = result.firstTokenMs;
}

/**
 * The upstream-failure fields this module copies onto transaction state.
 * Structurally satisfied by `UpstreamRequestError.details`, but spelled out here
 * because this module sits below upstream-client.ts and must not import it (see
 * test/architecture-boundaries.test.ts).
 */
export interface UpstreamFailureTransactionDetails {
  status: number | null;
  responseBody: Buffer;
  responseBodyTruncated: boolean;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
  streamSummary: OpenAiStreamSummary | null;
  clientDisconnectPhase: ClientDisconnectPhase;
  kind: StreamOutcome;
}

/** Copies upstream failure details onto transaction state. */
export function applyUpstreamFailureToTransaction(
  state: OpenAiProxyTransactionState,
  details: UpstreamFailureTransactionDetails
): void {
  state.upstreamStatus = details.status;
  state.responseBody = details.responseBody;
  state.responseHeaders = details.responseHeaders;
  state.firstTokenMs = details.firstTokenMs;
  state.streamTerminalEvent = details.streamSummary?.terminalEvent ?? null;
  state.clientDisconnectPhase = details.clientDisconnectPhase;
  state.streamOversizedEventCount = details.streamSummary?.oversizedEventCount ?? 0;
  state.responseBodyTruncated = details.responseBodyTruncated;
  state.responseModel = details.streamSummary?.responseModel ?? state.responseModel;
  state.usage = details.streamSummary?.usage ?? state.usage;
  state.streamOutcome = details.kind === "client_cancel"
    ? details.clientDisconnectPhase === "after_terminal"
      ? "client_cancel_after_terminal"
      : "client_cancel"
    : details.kind;
}

/** Input fields `finalizeFromTransaction` derives from transaction state. */
type TransactionDerivedField =
  | "status"
  | "upstreamStatus"
  | "streamTerminalEvent"
  | "clientDisconnectPhase"
  | "streamOutcome"
  | "streamOversizedEventCount"
  | "upstreamResponseTruncated"
  | "requestMetadata"
  | "requestType"
  | "sourceModel"
  | "targetModel"
  | "firstTokenMs"
  | "usage"
  | "errorSummary"
  | "compactBridgeReplacements"
  | "rawBody"
  | "requestHeaders"
  | "upstreamBody"
  | "responseBody"
  | "responseHeaders"
  | "clientResponseBody"
  | "clientResponseHeaders"
  | "compactResponseNormalized"
  | "compactResponseNormalizeReason"
  | "compactResponseSyntheticSource"
  | "sensitiveHeaderNames";

export type FinalizeFromTransactionInput =
  Omit<OpenAiProxyTransactionInput, TransactionDerivedField>
  & Partial<OpenAiProxyTransactionInput>;

/**
 * Finalizes a proxy transaction, projecting the shared transaction-state fields
 * onto the log/capture input. Anything passed in `overrides` wins, so callers
 * only spell out their per-route fields (route, compaction mode, url, ...) plus
 * any state field that needs a different value. Note `responseModel` and
 * `providerStatePortability` are deliberately NOT derived here: callers that
 * omit them must keep logging `undefined`.
 */
export function finalizeFromTransaction(
  transaction: OpenAiProxyTransactionState,
  overrides: FinalizeFromTransactionInput
): Promise<void> {
  return finalizeOpenAiProxyTransaction({
    status: transaction.status,
    upstreamStatus: transaction.upstreamStatus,
    streamTerminalEvent: transaction.streamTerminalEvent,
    clientDisconnectPhase: transaction.clientDisconnectPhase,
    streamOutcome: transaction.streamOutcome,
    streamOversizedEventCount: transaction.streamOversizedEventCount,
    upstreamResponseTruncated: transaction.responseBodyTruncated,
    requestMetadata: transaction.requestMetadata,
    requestType: transaction.requestType,
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
    compactResponseNormalized: transaction.compactResponseNormalized,
    compactResponseNormalizeReason: transaction.compactResponseNormalizeReason,
    compactResponseSyntheticSource: transaction.compactResponseSyntheticSource,
    sensitiveHeaderNames: transaction.sensitiveHeaderNames,
    ...overrides
  });
}

export async function finalizeOpenAiProxyTransaction(input: OpenAiProxyTransactionInput): Promise<void> {
  const completedAtIso = new Date().toISOString();
  const captureEnabled = input.captureWriter.isEnabled();
  const compactionDiagnostics = input.compactionMode
    ? buildCompactionDiagnostics({
        mode: input.compactionMode,
        requestBody: input.rawBody,
        requestHeaders: input.req.headers,
        responseBody: input.clientResponseBody ?? input.responseBody,
        responseHeaders: input.clientResponseHeaders ?? input.responseHeaders
      })
    : null;
  const logEntry = addLog(input.logger, {
    route: input.route,
    compactionMode: input.compactionMode ?? null,
    compactionDetectionSource: input.compactionDetectionSource ?? null,
    req: input.req,
    url: input.url,
    status: input.status,
    upstreamStatus: input.upstreamStatus,
    streamTerminalEvent: input.streamTerminalEvent,
    clientDisconnectPhase: input.clientDisconnectPhase,
    streamOutcome: input.streamOutcome,
    streamOversizedEventCount: input.streamOversizedEventCount,
    upstreamResponseTruncated: input.upstreamResponseTruncated,
    startedAt: input.startedAt,
    startedAtIso: input.startedAtIso,
    completedAtIso,
    endpoint: input.requestMetadata?.endpoint ?? endpointFromPath(input.url.pathname),
    requestType: input.requestType,
    reasoningEffort: input.requestMetadata?.reasoningEffort ?? null,
    requestSummary: input.requestMetadata?.requestSummary ?? null,
    incomingRequestBody: input.rawBody,
    upstreamRequestBody: input.upstreamBody,
    upstreamResponseBody: input.responseBody,
    upstreamResponseHeaders: input.responseHeaders,
    clientResponseBody: input.clientResponseBody,
    clientResponseHeaders: input.clientResponseHeaders,
    persistBody: input.persistBody,
    upstreamHost: input.upstream.host,
    requestId: input.requestId,
    sourceModel: input.sourceModel,
    targetModel: input.targetModel,
    responseModel: input.responseModel,
    firstTokenMs: input.firstTokenMs,
    usage: input.usage,
    errorSummary: input.errorSummary,
    providerStatePortability: input.providerStatePortability ?? null,
    compactResponseNormalized: input.compactResponseNormalized,
    compactResponseNormalizeReason: input.compactResponseNormalizeReason,
    compactResponseSyntheticSource: input.compactResponseSyntheticSource,
    compactionDiagnostics,
    capturePath: null,
    captureStatus: captureEnabled ? "pending" : "none"
  });
  const codexStatus = input.compactionMode && input.codexVersionMonitor
    ? input.codexVersionMonitor.snapshot(
        input.logger.recentLogs({ route: "compact", limit: CODEX_PROTOCOL_LOG_LIMIT })
      )
    : undefined;
  input.studioEvents.broadcastLog(logEntry, "insert", codexStatus);

  if (!captureEnabled) {
    return;
  }

  let captureRegistered = false;
  const capturePath = await persistCapture(
    input.captureWriter,
    () => ({
      request_id: input.requestId,
      time: input.startedAtIso,
      completed_at: completedAtIso,
      route: input.route,
      compaction_mode: input.compactionMode ?? null,
      compaction_detection_source: input.compactionDetectionSource ?? null,
      method: input.req.method ?? "GET",
      path: storedPathForUrl(input.url),
      upstream_url: redactUrlForStorage(input.upstream).toString(),
      upstream_host: input.upstream.host,
      source_model: input.sourceModel,
      target_model: input.targetModel,
      response_model: logEntry.response_model,
      response_model_source: logEntry.response_model_source,
      compact_bridge_replacements: input.compactBridgeReplacements,
      compact_response_normalized: input.compactResponseNormalized,
      compact_response_normalize_reason: input.compactResponseNormalizeReason,
      compact_response_synthetic_source: input.compactResponseSyntheticSource,
      compaction_diagnostics: compactionDiagnostics,
      upstream_status: input.upstreamStatus ?? null,
      stream_terminal_event: input.streamTerminalEvent ?? null,
      client_disconnect_phase: input.clientDisconnectPhase ?? "none",
      stream_outcome: input.streamOutcome ?? null,
      stream_oversized_event_count: input.streamOversizedEventCount ?? 0,
      upstream_response_truncated: input.upstreamResponseTruncated ?? false,
      incoming_request: {
        headers: serializeHeaders(input.req.headers, input.sensitiveHeaderNames),
        body: input.captureWriter.serializeBody(input.rawBody)
      },
      upstream_request: {
        headers: serializeHeaders(input.requestHeaders, input.sensitiveHeaderNames),
        body: input.captureWriter.serializeBody(input.upstreamBody)
      },
      upstream_response: {
        status: input.upstreamStatus ?? input.status,
        headers: serializeHeaders(input.responseHeaders),
        body: input.captureWriter.serializeBody(input.responseBody)
      },
      client_response: input.clientResponseBody
        ? {
            status: input.upstreamStatus ?? input.status,
            headers: serializeHeaders(input.clientResponseHeaders ?? {}),
            body: input.captureWriter.serializeBody(input.clientResponseBody)
          }
        : null
    }),
    (writtenPath) => {
      captureRegistered = true;
      input.logger.updateCapture(input.requestId, writtenPath, "present");
    }
  );

  if (!captureRegistered) {
    input.logger.updateCapture(
      input.requestId,
      capturePath,
      capturePath ? "present" : "none"
    );
  }
  const updatedLog = input.logger.getByRequestId(input.requestId);
  if (updatedLog.status === "found") {
    input.studioEvents.broadcastLog(updatedLog.entry, "update");
  }
}
