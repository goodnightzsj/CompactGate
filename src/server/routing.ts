import type {
  CompactGateConfig,
  RouteKind,
  RoutePreviewResponse
} from "../shared/types.js";

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

export function routeForPath(pathname: string): RouteKind {
  return isCompactPath(pathname) ? "compact" : "primary";
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

  return config.compact.model_template.replaceAll("{model}", sourceModel);
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

export function compactUpstreamPath(config: CompactGateConfig, requestPath: string): string {
  if (
    requestPath === "/v1/responses/compact" &&
    config.compact.upstream_mode === "primary" &&
    isAnyRouterHost(config.primary.base_url)
  ) {
    return "/v1/responses";
  }

  return requestPath;
}

export function previewRoute(
  method: string,
  path: string,
  body: unknown,
  config: CompactGateConfig
): RoutePreviewResponse {
  const parsedUrl = new URL(path, "http://compactgate.local");
  const route = routeForPath(parsedUrl.pathname);
  const upstreamBase = route === "compact" ? compactUpstreamBaseUrl(config) : config.primary.base_url;
  const upstreamPath = route === "compact" ? compactUpstreamPath(config, parsedUrl.pathname) : parsedUrl.pathname;
  const upstream = buildUpstreamUrl(upstreamBase, upstreamPath, parsedUrl.search);

  if (route === "primary") {
    const sourceModel = extractModelFromUnknown(body);
    return {
      route,
      method,
      path,
      upstream_url: upstream.toString(),
      upstream_host: upstream.host,
      source_model: sourceModel,
      target_model: sourceModel,
      body_rewritten: false,
      stream_removed: false
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

function extractModelFromUnknown(body: unknown): string | null {
  if (typeof body === "string") {
    try {
      return extractModelFromUnknown(JSON.parse(body));
    } catch {
      return null;
    }
  }

  if (!isRecord(body)) {
    return null;
  }

  return typeof body.model === "string" ? body.model : null;
}

function isAnyRouterHost(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "anyrouter.top" || hostname.endsWith(".anyrouter.top");
  } catch {
    return false;
  }
}

function parseJsonObject(rawBody: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("JSON body must be an object.");
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
