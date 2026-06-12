import type { IncomingMessage } from "node:http";
import type { CaptureRecord, DebugCaptureWriter } from "./debug-capture.js";
import type { RequestLogger } from "./logger.js";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource,
  RequestLogEntry,
  RequestTransport,
  RouteKind
} from "../shared/types.js";
import type { TokenUsageMetrics } from "./usage.js";
import { decodeBodyText, readHeaderString } from "./http-utils.js";

export function addLog(
  logger: RequestLogger,
  input: {
    route: RouteKind;
    req: IncomingMessage;
    url: URL;
    status: number;
    startedAt: number;
    startedAtIso: string;
    completedAtIso: string;
    endpoint: string;
    requestType: RequestTransport;
    reasoningEffort: string | null;
    requestSummary: string | null;
    incomingRequestBody: Buffer;
    upstreamRequestBody: Buffer;
    upstreamResponseBody: Buffer;
    clientResponseBody: Buffer | null;
    upstreamHost: string;
    requestId: string;
    sourceModel: string | null;
    targetModel: string | null;
    firstTokenMs: number | null;
    usage: TokenUsageMetrics;
    errorSummary: string | null;
    compactResponseNormalized: boolean;
    compactResponseNormalizeReason: CompactResponseNormalizeReason | null;
    compactResponseSyntheticSource: CompactResponseSyntheticSource | null;
  }
): RequestLogEntry {
  const entry: RequestLogEntry = {
    time: input.startedAtIso,
    completed_at: input.completedAtIso,
    route: input.route,
    method: input.req.method ?? "GET",
    path: `${input.url.pathname}${input.url.search}`,
    endpoint: input.endpoint,
    request_type: input.requestType,
    reasoning_effort: input.reasoningEffort,
    request_summary: input.requestSummary,
    incoming_request_body: bodyText(input.incomingRequestBody),
    upstream_request_body: bodyText(input.upstreamRequestBody),
    upstream_response_body: bodyText(input.upstreamResponseBody),
    client_response_body: input.clientResponseBody ? bodyText(input.clientResponseBody) : null,
    compact_response_normalized: input.compactResponseNormalized,
    compact_response_normalize_reason: input.compactResponseNormalizeReason,
    compact_response_synthetic_source: input.compactResponseSyntheticSource,
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

function bodyText(body: Buffer): string {
  return decodeBodyText(body);
}

export function emptyUsageMetrics(): TokenUsageMetrics {
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

export async function persistCapture(
  captureWriter: DebugCaptureWriter,
  createRecord: () => CaptureRecord
): Promise<void> {
  if (!captureWriter.isEnabled()) {
    return;
  }

  await captureWriter.write(createRecord());
}
