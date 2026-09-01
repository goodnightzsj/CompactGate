import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { CaptureRecord, DebugCaptureWriter } from "./debug-capture.js";
import type { RequestLogger } from "./logger.js";
import type {
  CompactResponseNormalizeReason,
  CompactResponseSyntheticSource,
  CompactionDiagnostics,
  ClientDisconnectPhase,
  OpenAiCompactionMode,
  OpenAiRequestDetectionSource,
  ProviderStatePortabilityLog,
  RequestLogEntry,
  ResponseModelSource,
  RequestTransport,
  RouteKind,
  StreamOutcome
} from "../shared/types.js";
import type { TokenUsageMetrics } from "./usage.js";
import { decodeBodyText, readHeaderString } from "./http-utils.js";
import { extractResponseModelFromBodies } from "./response-model.js";
import { effectiveResponseModel } from "./response-model.js";
import { parseCodexClientUserAgent } from "./codex-version.js";

export { emptyUsageMetrics } from "./usage.js";

/**
 * Matches the capture writer's per-body cap. `decodeBodyText` stays unbounded
 * because the normalizer and the failover evidence matchers need the whole text,
 * so the bound belongs here, at the point the text becomes a stored row.
 */
const MAX_PERSISTED_BODY_CHARS = 8 * 1024 * 1024;

/**
 * The Claude route accepts a 100 MiB request body and every log row holds four
 * body columns, so an unbounded copy let a single request write hundreds of MiB
 * into SQLite — blowing past the storage cap in one insert and forcing the prune
 * to VACUUM the whole file back down. The marker keeps a truncated row honest
 * rather than looking like a body that legitimately ended there.
 */
function persistedBodyText(body: Buffer): string {
  const text = decodeBodyText(body);
  if (text.length <= MAX_PERSISTED_BODY_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_PERSISTED_BODY_CHARS)}\n[CompactGate] body truncated at ${MAX_PERSISTED_BODY_CHARS} characters for storage.`;
}

const SENSITIVE_QUERY_KEYS = new Set([
  "api_key",
  "api-key",
  "apikey",
  "access_token",
  "access-token",
  "token",
  "client_secret",
  "client-secret",
  "authorization",
  "auth",
  "signature",
  "sig"
]);

export function addLog(
  logger: RequestLogger,
  input: {
    route: RouteKind;
    compactionMode?: OpenAiCompactionMode | null;
    compactionDetectionSource?: OpenAiRequestDetectionSource | null;
    req: IncomingMessage;
    url: URL;
    status: number;
    upstreamStatus?: number | null;
    streamTerminalEvent?: string | null;
    clientDisconnectPhase?: ClientDisconnectPhase;
    streamOutcome?: StreamOutcome | null;
    streamOversizedEventCount?: number;
    upstreamResponseTruncated?: boolean;
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
    upstreamResponseHeaders?: IncomingHttpHeaders;
    clientResponseBody: Buffer | null;
    clientResponseHeaders?: IncomingHttpHeaders | null;
    persistBody: boolean;
    upstreamHost: string;
    requestId: string;
    sourceModel: string | null;
    targetModel: string | null;
    responseModel?: string | null;
    firstTokenMs: number | null;
    usage: TokenUsageMetrics;
    errorSummary: string | null;
    providerStatePortability?: ProviderStatePortabilityLog | null;
    compactResponseNormalized: boolean;
    compactResponseNormalizeReason: CompactResponseNormalizeReason | null;
    compactResponseSyntheticSource: CompactResponseSyntheticSource | null;
    compactionDiagnostics?: CompactionDiagnostics | null;
    capturePath: string | null;
    captureStatus: RequestLogEntry["capture_status"];
  }
): RequestLogEntry {
  const responseModel = input.responseModel ?? extractResponseModelFromBodies(
    input.upstreamResponseBody,
    input.clientResponseBody,
    input.upstreamResponseHeaders ?? {},
    input.clientResponseHeaders ?? {}
  );
  const responseModelSource = resolveResponseModelSource({
    responseModel,
    targetModel: input.targetModel,
    status: input.status,
    errorSummary: input.errorSummary,
    streamOutcome: input.streamOutcome ?? null,
    requestType: input.requestType
  });
  const userAgent = readHeaderString(input.req.headers["user-agent"]);
  const entry: RequestLogEntry = {
    time: input.startedAtIso,
    completed_at: input.completedAtIso,
    route: input.route,
    compaction_mode: input.compactionMode ?? null,
    compaction_detection_source: input.compactionDetectionSource ?? null,
    method: input.req.method ?? "GET",
    path: storedPathForUrl(input.url),
    endpoint: input.endpoint,
    request_type: input.requestType,
    reasoning_effort: input.reasoningEffort,
    request_summary: input.requestSummary,
    incoming_request_body: input.persistBody ? persistedBodyText(input.incomingRequestBody) : null,
    upstream_request_body: input.persistBody ? persistedBodyText(input.upstreamRequestBody) : null,
    upstream_response_body: input.persistBody ? persistedBodyText(input.upstreamResponseBody) : null,
    client_response_body: input.persistBody && input.clientResponseBody ? persistedBodyText(input.clientResponseBody) : null,
    body_status: input.persistBody ? "present" : "none",
    compact_response_normalized: input.compactResponseNormalized,
    compact_response_normalize_reason: input.compactResponseNormalizeReason,
    compact_response_synthetic_source: input.compactResponseSyntheticSource,
    compaction_diagnostics: input.compactionDiagnostics ?? null,
    source_model: input.sourceModel,
    target_model: input.targetModel,
    response_model: responseModel,
    response_model_source: responseModelSource,
    effective_response_model: effectiveResponseModel(responseModel, input.targetModel, responseModelSource),
    codex_client: parseCodexClientUserAgent(userAgent),
    status: input.status,
    upstream_status: input.upstreamStatus ?? null,
    stream_terminal_event: input.streamTerminalEvent ?? null,
    client_disconnect_phase: input.clientDisconnectPhase ?? "none",
    stream_outcome: input.streamOutcome ?? null,
    stream_oversized_event_count: input.streamOversizedEventCount ?? 0,
    upstream_response_truncated: input.upstreamResponseTruncated ?? false,
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
    user_agent: userAgent,
    request_id: input.requestId,
    error_summary: input.errorSummary,
    provider_state_portability: input.providerStatePortability ?? null,
    capture_path: input.capturePath,
    capture_status: input.captureStatus
  };
  logger.add(entry);
  return entry;
}

export function resolveResponseModelSource(input: {
  responseModel: string | null;
  targetModel: string | null;
  status: number;
  errorSummary: string | null;
  streamOutcome: StreamOutcome | null;
  requestType: RequestTransport;
}): ResponseModelSource {
  if (input.responseModel) {
    return "upstream";
  }

  const successful = input.status >= 200 && input.status < 300 &&
    input.errorSummary === null &&
    (input.streamOutcome === "success" ||
      (input.streamOutcome === null && input.requestType !== "stream"));
  return successful && input.targetModel ? "target_fallback" : "unavailable";
}

export function redactUrlForStorage(url: URL): URL {
  const next = new URL(url);
  const entries = [...next.searchParams.entries()];
  next.search = "";
  for (const [name, value] of entries) {
    next.searchParams.append(
      name,
      SENSITIVE_QUERY_KEYS.has(name.toLowerCase()) ? "[redacted]" : value
    );
  }
  return next;
}

export function storedPathForUrl(url: URL): string {
  const storedUrl = redactUrlForStorage(url);
  return `${storedUrl.pathname}${storedUrl.search}`;
}

export async function persistCapture(
  captureWriter: DebugCaptureWriter,
  createRecord: () => CaptureRecord,
  onWritten?: (capturePath: string) => void
): Promise<string | null> {
  if (!captureWriter.isEnabled()) {
    return null;
  }

  try {
    return await captureWriter.write(createRecord(), onWritten);
  } catch {
    return null;
  }
}
