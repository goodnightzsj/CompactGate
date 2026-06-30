import type {
  CompactGateConfig,
  RouteKind,
  RoutePreviewResponse
} from "../shared/types.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";

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

export function routeForPath(pathname: string, body?: unknown): RouteKind {
  return isCompactPath(pathname) || isBodyAwareCompactRequest(pathname, body) ? "compact" : "primary";
}

export function isV1Path(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

export function isCompactPath(pathname: string): boolean {
  return pathname === "/v1/responses/compact";
}

export function isBodyAwareCompactRequest(pathname: string, body?: unknown): boolean {
  if (pathname !== "/v1/responses") {
    return false;
  }

  const parsed = parseJsonBody(body);
  const input = Array.isArray(parsed?.input) ? parsed.input : null;
  return Boolean(input?.some((item) => isRecord(item) && item.type === "compaction_trigger"));
}

export function deriveCompactModel(sourceModel: string, config: CompactGateConfig): string {
  if (config.compact.model_mode === "custom") {
    return config.compact.model_override;
  }

  const linkedSource = config.primary.model_override?.trim() || sourceModel;
  return config.compact.model_template.replaceAll("{model}", linkedSource);
}

export function rewritePrimaryBody(rawBody: Buffer, config: CompactGateConfig): RewriteResult {
  const modelOverride = config.primary.model_override?.trim();
  if (!modelOverride) {
    const extracted = extractJsonModel(rawBody);
    return {
      sourceModel: extracted.sourceModel,
      targetModel: extracted.sourceModel,
      body: rawBody,
      bodyRewritten: false,
      streamRemoved: false
    };
  }

  const parsed = parseJsonRecord(rawBody);
  const sourceModel = typeof parsed?.model === "string" ? parsed.model : null;
  if (!parsed || sourceModel === null) {
    return {
      sourceModel,
      targetModel: sourceModel,
      body: rawBody,
      bodyRewritten: false,
      streamRemoved: false
    };
  }

  parsed.model = modelOverride;

  return {
    sourceModel,
    targetModel: modelOverride,
    body: Buffer.from(JSON.stringify(parsed)),
    bodyRewritten: sourceModel !== modelOverride,
    streamRemoved: false
  };
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
  base.search = search;

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
  config: CompactGateConfig
): RoutePreviewResponse {
  const parsedUrl = new URL(path, "http://compactgate.local");
  const route = routeForPath(parsedUrl.pathname, body);
  const upstreamBase = route === "compact" ? compactUpstreamBaseUrl(config) : config.primary.base_url;
  const upstreamPath = route === "compact" ? compactUpstreamPath(config, parsedUrl.pathname) : parsedUrl.pathname;
  const upstream = buildUpstreamUrl(upstreamBase, upstreamPath, parsedUrl.search);

  if (route === "primary") {
    const rewrite = rewritePrimaryBody(previewBodyToBuffer(body), config);
    return {
      route,
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
    route,
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

function parseJsonObject(rawBody: Buffer): Record<string, unknown> {
  const parsed = parseJsonRecord(rawBody);

  if (!parsed) {
    throw new Error("JSON body must be an object.");
  }

  return parsed;
}
