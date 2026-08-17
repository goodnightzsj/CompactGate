import type { IncomingHttpHeaders } from "node:http";
import type {
  CompactGateConfig,
  OpenAiCompactionMode,
  OpenAiRequestDetectionSource,
  RoutePreviewResponse
} from "../shared/types.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";
import {
  buildClaudeUpstreamUrl,
  resolveClaudeMappedModel,
  resolveClaudeRequestRouting
} from "./claude-models.js";
import { resolveUpstreamPath } from "./upstream-url.js";

const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata";
const ANTHROPIC_PROXY_PREFIX = "/anthropic";

export interface RewriteResult {
  sourceModel: string | null;
  targetModel: string | null;
  body: Buffer;
  bodyRewritten: boolean;
  streamRemoved: boolean;
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

export function compactionImplementation(
  mode: OpenAiCompactionMode,
  body: unknown,
  headers: IncomingHttpHeaders = {}
): string {
  const parsed = parseJsonBody(body);
  const bodyImplementation = metadataCompactionImplementation(parsed?.client_metadata, true);
  if (bodyImplementation) {
    return bodyImplementation;
  }
  const headerImplementation = metadataCompactionImplementation(
    readHeaderValue(headers, CODEX_TURN_METADATA_KEY),
    false
  );
  if (headerImplementation) {
    return headerImplementation;
  }
  if (mode === "remote_v1") {
    return "responses_compact_endpoint";
  }
  return mode === "remote_v2" ? "responses_compaction_v2" : "local";
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
  const reasoningEffort = endpoint === undefined || endpoint === "/responses" || endpoint === "/v1/responses"
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

export function rewriteCompactBody(rawBody: Buffer, config: CompactGateConfig): RewriteResult {
  const parsed = parseJsonRecord(rawBody);
  if (!parsed) {
    throw new Error("JSON body must be an object.");
  }
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

export function buildUpstreamUrl(baseUrl: string, requestPath: string, search = ""): URL {
  const base = new URL(baseUrl);
  base.pathname = resolveUpstreamPath(base.pathname, requestPath, "replace-client-api-root");
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

export function previewRoute(
  method: string,
  path: string,
  body: unknown,
  config: CompactGateConfig,
  headers?: IncomingHttpHeaders
): RoutePreviewResponse {
  const parsedUrl = new URL(path, "http://compactgate.local");
  if (isClaudeIngressPath(parsedUrl.pathname)) {
    return previewClaudeRoute(method, path, parsedUrl, body, config, headers);
  }
  const classification = classifyOpenAiRequest(parsedUrl.pathname, body, headers);
  const usesPrimaryPlan = classification.route === "primary" || classification.compactionMode === "remote_v2";
  const upstreamConfig = usesPrimaryPlan
    ? config.primary
    : config.compact.upstream_mode === "split"
      ? config.compact
      : config.primary;
  const upstreamBase = upstreamConfig.base_url;
  const upstreamPath = upstreamConfig.upstream_protocol === "anthropic_messages"
    ? "/v1/messages"
    : upstreamConfig.upstream_protocol === "openai_chat"
      ? "/v1/chat/completions"
      : parsedUrl.pathname;
  const upstream = upstreamConfig.upstream_protocol === "anthropic_messages"
    ? buildClaudeUpstreamUrl(upstreamBase, upstreamPath, parsedUrl.search)
    : buildUpstreamUrl(upstreamBase, upstreamPath, parsedUrl.search);
  const ingressProtocol = "openai_responses" as const;
  const translationMode = upstreamConfig.upstream_protocol === ingressProtocol ? "passthrough" : "translate";

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
      ingress_protocol: ingressProtocol,
      upstream_protocol: upstreamConfig.upstream_protocol,
      translation_mode: translationMode,
      source_model: rewrite.sourceModel,
      target_model: rewrite.targetModel,
      body_rewritten: rewrite.bodyRewritten,
      stream_removed: rewrite.streamRemoved
    };
  }

  const parsedBody = parseJsonBody(body);
  const sourceModel = typeof parsedBody?.model === "string" ? parsedBody.model : null;
  const targetModel = sourceModel ? deriveCompactModel(sourceModel, config) : null;
  return {
    route: classification.route,
    compaction_mode: classification.compactionMode,
    detection_source: classification.detectionSource,
    method,
    path,
    upstream_url: upstream.toString(),
    upstream_host: upstream.host,
    ingress_protocol: ingressProtocol,
    upstream_protocol: upstreamConfig.upstream_protocol,
    translation_mode: translationMode,
    source_model: sourceModel,
    target_model: targetModel,
    body_rewritten: Boolean(sourceModel && sourceModel !== targetModel),
    stream_removed: false
  };
}

export function isClaudeIngressPath(pathname: string): boolean {
  return pathname === ANTHROPIC_PROXY_PREFIX || pathname.startsWith(`${ANTHROPIC_PROXY_PREFIX}/`);
}

function previewClaudeRoute(
  method: string,
  path: string,
  parsedUrl: URL,
  body: unknown,
  config: CompactGateConfig,
  headers?: IncomingHttpHeaders
): RoutePreviewResponse {
  const requestPath = parsedUrl.pathname.slice(ANTHROPIC_PROXY_PREFIX.length) || "/";
  const countTokens = requestPath === "/v1/messages/count_tokens" || requestPath === "/messages/count_tokens";
  const rawBody = previewBodyToBuffer(body);
  const parsedBody = parseJsonBody(body);
  const sourceModel = typeof parsedBody?.model === "string" ? parsedBody.model : null;
  const routing = resolveClaudeRequestRouting(
    config,
    rawBody,
    sourceModel,
    headers ?? {},
    "127.0.0.1"
  );
  const upstreamConfig = routing.config.claude.primary;
  const upstreamPath = upstreamConfig.upstream_protocol === "anthropic_messages"
    ? requestPath
    : upstreamConfig.upstream_protocol === "openai_chat"
      ? "/v1/chat/completions"
      : countTokens
        ? "/v1/responses/input_tokens"
        : "/v1/responses";
  const upstream = upstreamConfig.upstream_protocol === "anthropic_messages"
    ? buildClaudeUpstreamUrl(upstreamConfig.base_url, upstreamPath, parsedUrl.search)
    : buildUpstreamUrl(upstreamConfig.base_url, upstreamPath, parsedUrl.search);
  const targetModel = routing.sceneModel ??
    resolveClaudeMappedModel(sourceModel, routing.config, rawBody) ??
    sourceModel;
  return {
    route: "claude",
    compaction_mode: null,
    detection_source: null,
    method,
    path,
    upstream_url: upstream.toString(),
    upstream_host: upstream.host,
    ingress_protocol: "anthropic_messages",
    upstream_protocol: upstreamConfig.upstream_protocol,
    translation_mode: upstreamConfig.upstream_protocol === "anthropic_messages" ? "passthrough" : "translate",
    source_model: sourceModel,
    target_model: targetModel,
    body_rewritten: Boolean(sourceModel && targetModel && sourceModel !== targetModel),
    stream_removed: false,
    profile_id: routing.profileId,
    profile_source: routing.profileSource,
    claude_scene: routing.scene,
    scene_text_bytes: routing.textBytes
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
  const metadata = parseCodexTurnMetadata(value);
  return isRecord(metadata?.compaction) &&
    metadata.compaction.implementation === "responses_compaction_v2";
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

function metadataCompactionImplementation(
  metadataContainer: unknown,
  nested: boolean
): string | null {
  const rawMetadata = nested && isRecord(metadataContainer)
    ? metadataContainer[CODEX_TURN_METADATA_KEY]
    : metadataContainer;
  const metadata = parseCodexTurnMetadata(rawMetadata);
  const implementation = isRecord(metadata?.compaction)
    ? metadata.compaction.implementation
    : null;
  return typeof implementation === "string" && implementation.trim().length > 0
    ? implementation.trim()
    : null;
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

function primaryClassification(): OpenAiRequestClassification {
  return { route: "primary", compactionMode: null, detectionSource: null };
}
