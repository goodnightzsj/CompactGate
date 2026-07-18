import type { IncomingHttpHeaders } from "node:http";
import type {
  CompactGateConfig,
  OpenAiCompactionMode,
  OpenAiRequestDetectionSource,
  RouteKind,
  RoutePreviewResponse
} from "../shared/types.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";

const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata";

export interface RewriteResult {
  sourceModel: string | null;
  targetModel: string | null;
  body: Buffer;
  bodyRewritten: boolean;
  streamRemoved: boolean;
}

export interface ExtractedModel {
  sourceModel: string | null;
}

export type OpenAiRequestClassification =
  | { route: "primary"; compactionMode: null; detectionSource: null }
  | {
      route: "compact";
      compactionMode: OpenAiCompactionMode;
      detectionSource: OpenAiRequestDetectionSource;
    };

export function classifyOpenAiRequest(
  pathname: string,
  body?: unknown,
  headers?: IncomingHttpHeaders
): OpenAiRequestClassification {
  if (isCompactPath(pathname)) {
    return { route: "compact", compactionMode: "remote_v1", detectionSource: "path" };
  }

  if (pathname !== "/v1/responses") {
    return primaryClassification();
  }

  const parsed = parseJsonBody(body);
  if (hasCompactionTrigger(parsed?.input)) {
    return { route: "compact", compactionMode: "remote_v2", detectionSource: "input" };
  }

  const bodyRequestKind = metadataCompactionMode(parsed?.client_metadata, true);
  if (bodyRequestKind === "local" || bodyRequestKind === "remote_v2") {
    return { route: "compact", compactionMode: bodyRequestKind, detectionSource: "body_metadata" };
  }
  if (bodyRequestKind === "other") {
    return primaryClassification();
  }

  const headerRequestKind = metadataCompactionMode(readHeaderValue(headers, CODEX_TURN_METADATA_KEY), false);
  if (headerRequestKind === "local" || headerRequestKind === "remote_v2") {
    return { route: "compact", compactionMode: headerRequestKind, detectionSource: "header_metadata" };
  }

  return primaryClassification();
}

/**
 * Remote V2 follow-up turns carry provider-owned compaction state even though
 * their turn metadata is `request_kind=turn`. That state must not enter the
 * legacy V1 readable bridge.
 */
export function hasRemoteV2CompactionState(
  pathname: string,
  body?: unknown,
  headers?: IncomingHttpHeaders
): boolean {
  if (pathname !== "/v1/responses") {
    return false;
  }

  const parsed = parseJsonBody(body);
  if (!hasCompactionItem(parsed?.input)) {
    return false;
  }

  if (hasRemoteV2Metadata(parsed?.client_metadata)) {
    return true;
  }

  if (hasRemoteV2Metadata(readHeaderValue(headers, CODEX_TURN_METADATA_KEY))) {
    return true;
  }

  const betaFeatures = readHeaderValue(headers, "x-codex-beta-features");
  const values = Array.isArray(betaFeatures) ? betaFeatures : [betaFeatures];
  return values.some((value) =>
    typeof value === "string" && value.split(/[\s,]+/).some((feature) => feature === "remote_compaction_v2")
  );
}

/** Compatibility wrapper for callers that only need the legacy route kind. */
export function routeForPath(pathname: string, body?: unknown): RouteKind {
  return classifyOpenAiRequest(pathname, body).route;
}

/** Compatibility wrapper for the former body-aware predicate. */
export function isBodyAwareCompactRequest(pathname: string, body?: unknown): boolean {
  return pathname === "/v1/responses" && classifyOpenAiRequest(pathname, body).route === "compact";
}

export function isV1Path(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

export function isCompactPath(pathname: string): boolean {
  return pathname === "/v1/responses/compact";
}

export function deriveCompactModel(sourceModel: string, config: CompactGateConfig): string {
  if (config.compact.model_mode === "custom") {
    return config.compact.model_override;
  }

  const linkedSource = config.primary.model_override?.trim() || sourceModel;
  return config.compact.model_template.replaceAll("{model}", linkedSource);
}

export function rewritePrimaryBody(
  rawBody: Buffer,
  config: CompactGateConfig,
  endpoint?: string
): RewriteResult {
  const modelOverride = config.primary.model_override?.trim();
  const reasoningEffort = isResponsesEndpoint(endpoint)
    ? config.primary.reasoning_effort
    : "";

  const parsed = parseJsonRecord(rawBody);
  const sourceModel = typeof parsed?.model === "string" ? parsed.model : null;
  if (!parsed) {
    return {
      sourceModel,
      targetModel: sourceModel,
      body: rawBody,
      bodyRewritten: false,
      streamRemoved: false
    };
  }

  let bodyRewritten = false;
  let targetModel = sourceModel;

  if (modelOverride && sourceModel !== null) {
    targetModel = modelOverride;
    if (sourceModel !== modelOverride) {
      parsed.model = modelOverride;
      bodyRewritten = true;
    }
  }

  if (reasoningEffort) {
    const currentReasoning = isRecord(parsed.reasoning) ? parsed.reasoning : null;
    if (currentReasoning?.effort !== reasoningEffort) {
      parsed.reasoning = {
        ...(currentReasoning ?? {}),
        effort: reasoningEffort
      };
      bodyRewritten = true;
    }
  }

  return {
    sourceModel,
    targetModel,
    body: bodyRewritten ? Buffer.from(JSON.stringify(parsed)) : rawBody,
    bodyRewritten,
    streamRemoved: false
  };
}

function isResponsesEndpoint(endpoint: string | undefined): boolean {
  return endpoint === undefined || endpoint === "/responses" || endpoint === "/v1/responses";
}

export function rewriteCompactBody(rawBody: Buffer, config: CompactGateConfig): RewriteResult {
  const parsed = parseJsonObject(rawBody);
  const model = parsed.model;

  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("Compact request body must include a string model.");
  }

  const sourceModel = model;
  const targetModel = deriveCompactModel(sourceModel, config);
  parsed.model = targetModel;

  return {
    sourceModel,
    targetModel,
    body: Buffer.from(JSON.stringify(parsed)),
    bodyRewritten: sourceModel !== targetModel,
    streamRemoved: false
  };
}

export function extractJsonModel(rawBody: Buffer): ExtractedModel {
  try {
    const parsed = parseJsonObject(rawBody);
    return {
      sourceModel: typeof parsed.model === "string" ? parsed.model : null
    };
  } catch {
    return { sourceModel: null };
  }
}

export function buildUpstreamUrl(baseUrl: string, requestPath: string, search = ""): URL {
  const base = new URL(baseUrl);
  const suffix = requestPath.startsWith("/v1") ? requestPath.slice(3) || "/" : requestPath;
  const cleanBasePath = base.pathname.replace(/\/+$/, "");
  const cleanSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;

  base.pathname = `${cleanBasePath}${cleanSuffix}`.replace(/\/{2,}/g, "/");
  const requestSearch = new URLSearchParams(search);
  for (const name of new Set(requestSearch.keys())) {
    base.searchParams.delete(name);
    for (const value of requestSearch.getAll(name)) {
      base.searchParams.append(name, value);
    }
  }

  return base;
}

export function compactUpstreamBaseUrl(config: CompactGateConfig): string {
  return config.compact.upstream_mode === "split"
    ? config.compact.base_url
    : config.primary.base_url;
}

export function compactUpstreamPath(_config: CompactGateConfig, requestPath: string): string {
  return requestPath;
}

export function previewRoute(
  method: string,
  path: string,
  body: unknown,
  config: CompactGateConfig,
  headers?: IncomingHttpHeaders
): RoutePreviewResponse {
  const parsedUrl = new URL(path, "http://compactgate.local");
  const classification = classifyOpenAiRequest(parsedUrl.pathname, body, headers);
  const usesPrimaryPlan = classification.route === "primary" || classification.compactionMode === "remote_v2";
  const upstreamBase = usesPrimaryPlan ? config.primary.base_url : compactUpstreamBaseUrl(config);
  const upstreamPath = usesPrimaryPlan
    ? parsedUrl.pathname
    : compactUpstreamPath(config, parsedUrl.pathname);
  const upstream = buildUpstreamUrl(upstreamBase, upstreamPath, parsedUrl.search);

  if (usesPrimaryPlan) {
    const rewrite = rewritePrimaryBody(previewBodyToBuffer(body), config, parsedUrl.pathname);
    return {
      route: classification.route,
      compaction_mode: classification.compactionMode,
      detection_source: classification.detectionSource,
      method,
      path,
      upstream_url: upstream.toString(),
      upstream_host: upstream.host,
      source_model: rewrite.sourceModel,
      target_model: rewrite.targetModel,
      body_rewritten: rewrite.bodyRewritten,
      stream_removed: rewrite.streamRemoved
    };
  }

  const sourceModel = extractModelFromUnknown(body);
  const targetModel = sourceModel ? deriveCompactModel(sourceModel, config) : null;
  return {
    route: classification.route,
    compaction_mode: classification.compactionMode,
    detection_source: classification.detectionSource,
    method,
    path,
    upstream_url: upstream.toString(),
    upstream_host: upstream.host,
    source_model: sourceModel,
    target_model: targetModel,
    body_rewritten: Boolean(sourceModel && sourceModel !== targetModel),
    stream_removed: false
  };
}

function previewBodyToBuffer(body: unknown): Buffer {
  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body === undefined) {
    return Buffer.alloc(0);
  }

  const serialized = JSON.stringify(body);
  return typeof serialized === "string" ? Buffer.from(serialized) : Buffer.alloc(0);
}

function extractModelFromUnknown(body: unknown): string | null {
  const parsed = parseJsonBody(body);
  return typeof parsed?.model === "string" ? parsed.model : null;
}

function parseJsonBody(body: unknown): Record<string, unknown> | null {
  if (Buffer.isBuffer(body)) {
    return parseJsonRecord(body);
  }

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return isRecord(body) ? body : null;
}

function hasCompactionTrigger(input: unknown): boolean {
  return Array.isArray(input) && input.some(
    (item) => isRecord(item) && item.type === "compaction_trigger"
  );
}

function hasCompactionItem(input: unknown): boolean {
  return Array.isArray(input) && input.some(
    (item) => isRecord(item) && item.type === "compaction" && typeof item.encrypted_content === "string"
  );
}

function hasRemoteV2Metadata(value: unknown): boolean {
  const text = Array.isArray(value)
    ? value.find((item): item is string => typeof item === "string")
    : value;
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }

  try {
    const metadata = JSON.parse(text) as unknown;
    return isRecord(metadata) && isRecord(metadata.compaction) &&
      metadata.compaction.implementation === "responses_compaction_v2";
  } catch {
    return false;
  }
}

type MetadataRequestKind = "local" | "remote_v2" | "other" | "unavailable";

function metadataCompactionMode(metadataContainer: unknown, nested: boolean): MetadataRequestKind {
  if (nested && (!isRecord(metadataContainer) || !Object.hasOwn(metadataContainer, CODEX_TURN_METADATA_KEY))) {
    return "unavailable";
  }

  const rawMetadata = nested && isRecord(metadataContainer)
    ? metadataContainer[CODEX_TURN_METADATA_KEY]
    : metadataContainer;
  const metadata = parseCodexTurnMetadata(rawMetadata);
  if (!metadata) {
    return "unavailable";
  }
  if (metadata.request_kind !== "compaction") {
    return "other";
  }
  return isRecord(metadata.compaction) && metadata.compaction.implementation === "responses_compaction_v2"
    ? "remote_v2"
    : "local";
}

function parseCodexTurnMetadata(value: unknown): Record<string, unknown> | null {
  const text = Array.isArray(value)
    ? value.find((item): item is string => typeof item === "string")
    : value;
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readHeaderValue(
  headers: IncomingHttpHeaders | undefined,
  name: string
): string | string[] | undefined {
  if (!headers) {
    return undefined;
  }

  const exact = headers[name];
  if (exact !== undefined) {
    return exact;
  }

  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

function parseJsonObject(rawBody: Buffer): Record<string, unknown> {
  const parsed = parseJsonRecord(rawBody);

  if (!parsed) {
    throw new Error("JSON body must be an object.");
  }

  return parsed;
}

function primaryClassification(): OpenAiRequestClassification {
  return { route: "primary", compactionMode: null, detectionSource: null };
}
