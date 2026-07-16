import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource,
  RequestTransport,
  RouteKind
} from "../shared/types.js";
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
import type {
  RequestMetadata,
  TokenUsageMetrics
} from "./usage.js";

export interface OpenAiProxyTransactionState {
  status: number;
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
  compactBridgeReplacements: number;
  compactResponseNormalized: boolean;
  compactResponseNormalizeReason: CompactResponseNormalizeReason | null;
  compactResponseSyntheticSource: CompactResponseSyntheticSource | null;
}

export interface OpenAiProxyUpstreamResult {
  status: number;
  errorSummary: string | null;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
}

export interface OpenAiProxyTransactionInput {
  logger: RequestLogger;
  captureWriter: DebugCaptureWriter;
  studioEvents: StudioEventBroadcaster;
  req: IncomingMessage;
  url: URL;
  route: RouteKind;
  status: number;
  startedAt: number;
  startedAtIso: string;
  requestMetadata: RequestMetadata | null;
  requestType: RequestTransport;
  upstream: URL;
  requestId: string;
  sourceModel: string | null;
  targetModel: string | null;
  firstTokenMs: number | null;
  usage: TokenUsageMetrics;
  errorSummary: string | null;
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
}

export function createOpenAiProxyTransactionState(): OpenAiProxyTransactionState {
  return {
    status: 502,
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
    compactBridgeReplacements: 0,
    compactResponseNormalized: false,
    compactResponseNormalizeReason: null,
    compactResponseSyntheticSource: null
  };
}

export function applyOpenAiProxyUpstreamResult(
  state: OpenAiProxyTransactionState,
  result: OpenAiProxyUpstreamResult
): void {
  state.status = result.status;
  state.errorSummary = result.errorSummary;
  state.responseBody = result.responseBody;
  state.responseHeaders = result.responseHeaders;
  state.firstTokenMs = result.firstTokenMs;
}

export async function finalizeOpenAiProxyTransaction(input: OpenAiProxyTransactionInput): Promise<void> {
  const completedAtIso = new Date().toISOString();
  const captureEnabled = input.captureWriter.isEnabled();
  const logEntry = addLog(input.logger, {
    route: input.route,
    req: input.req,
    url: input.url,
    status: input.status,
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
    clientResponseBody: input.clientResponseBody,
    persistBody: input.persistBody,
    upstreamHost: input.upstream.host,
    requestId: input.requestId,
    sourceModel: input.sourceModel,
    targetModel: input.targetModel,
    firstTokenMs: input.firstTokenMs,
    usage: input.usage,
    errorSummary: input.errorSummary,
    compactResponseNormalized: input.compactResponseNormalized,
    compactResponseNormalizeReason: input.compactResponseNormalizeReason,
    compactResponseSyntheticSource: input.compactResponseSyntheticSource,
    capturePath: null,
    captureStatus: captureEnabled ? "pending" : "none"
  });
  input.studioEvents.broadcastLog(logEntry, "insert");

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
      method: input.req.method ?? "GET",
      path: storedPathForUrl(input.url),
      upstream_url: redactUrlForStorage(input.upstream).toString(),
      upstream_host: input.upstream.host,
      source_model: input.sourceModel,
      target_model: input.targetModel,
      compact_bridge_replacements: input.compactBridgeReplacements,
      compact_response_normalized: input.compactResponseNormalized,
      compact_response_normalize_reason: input.compactResponseNormalizeReason,
      compact_response_synthetic_source: input.compactResponseSyntheticSource,
      incoming_request: {
        headers: serializeHeaders(input.req.headers),
        body: input.captureWriter.serializeBody(input.rawBody)
      },
      upstream_request: {
        headers: serializeHeaders(input.requestHeaders),
        body: input.captureWriter.serializeBody(input.upstreamBody)
      },
      upstream_response: {
        status: input.status,
        headers: serializeHeaders(input.responseHeaders),
        body: input.captureWriter.serializeBody(input.responseBody)
      },
      client_response: input.clientResponseBody
        ? {
            status: input.status,
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
