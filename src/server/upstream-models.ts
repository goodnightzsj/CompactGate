import {
  isRecord,
  summaryForError
} from "./http-utils.js";
import {
  requestJson,
  UpstreamStatusError
} from "./upstream-client.js";

export type UpstreamModelsResponse = {
  models: string[];
  upstream_host: string;
  error: string | null;
};

type FetchUpstreamModelsOptions = {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

const COMPATIBILITY_PATH_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude"
] as const;

export async function fetchUpstreamModels({
  baseUrl,
  headers,
  timeoutMs
}: FetchUpstreamModelsOptions): Promise<UpstreamModelsResponse> {
  const upstreams = buildModelListUrls(baseUrl);
  const attempts: string[] = [];

  for (const upstream of upstreams) {
    try {
      const body = await requestJson(upstream, headers, timeoutMs);
      return {
        models: extractModelIds(body),
        upstream_host: upstream.host,
        error: null
      };
    } catch (error) {
      attempts.push(`${upstream.pathname}: ${modelFetchError(error)}`);
      if (isMissingModelEndpoint(error)) {
        continue;
      }

      return {
        models: [],
        upstream_host: upstream.host,
        error: `上游模型列表不可用：${modelFetchError(error)}`
      };
    }
  }

  return {
    models: [],
    upstream_host: upstreams[0]?.host ?? "",
    error: `上游模型列表不可用。已尝试 ${attempts.join("；")}`
  };
}

export function buildModelListUrls(baseUrl: string): URL[] {
  const base = new URL(baseUrl);
  base.search = "";
  base.hash = "";
  const basePath = trimTrailingSlashes(base.pathname);
  const candidates: URL[] = [];

  if (endsWithVersionSegment(basePath)) {
    candidates.push(withPath(base, `${basePath}/models`));
    if (!basePath.endsWith("/v1")) {
      candidates.push(withPath(base, `${basePath}/v1/models`));
    }
  } else {
    candidates.push(
      withPath(base, `${basePath}/v1/models`),
      withPath(base, `${basePath}/models`)
    );
  }

  const compatibilityRoot = stripCompatibilitySuffix(basePath);
  if (compatibilityRoot !== null) {
    candidates.push(
      withPath(base, `${compatibilityRoot}/v1/models`),
      withPath(base, `${compatibilityRoot}/models`)
    );
  }

  candidates.push(
    withPath(base, "/v1/models"),
    withPath(base, "/models")
  );

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toString();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function extractModelIds(value: unknown): string[] {
  const models = new Set<string>();
  const candidates = isRecord(value) && Array.isArray(value.data)
    ? value.data
    : Array.isArray(value)
      ? value
      : [];

  for (const item of candidates) {
    const id = typeof item === "string"
      ? readString(item)
      : isRecord(item)
        ? readString(item.id) ?? readString(item.name) ?? readString(item.model)
        : null;
    if (id) {
      models.add(id);
    }
  }

  return [...models].sort((left, right) => left.localeCompare(right));
}

function withPath(base: URL, pathname: string): URL {
  const candidate = new URL(base);
  candidate.pathname = pathname.replace(/\/{2,}/g, "/") || "/";
  return candidate;
}

function trimTrailingSlashes(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "/" ? "" : trimmed;
}

function endsWithVersionSegment(pathname: string): boolean {
  return /\/v\d+$/.test(pathname);
}

function stripCompatibilitySuffix(pathname: string): string | null {
  for (const suffix of COMPATIBILITY_PATH_SUFFIXES) {
    if (pathname.endsWith(suffix)) {
      return pathname.slice(0, -suffix.length).replace(/\/+$/, "");
    }
  }

  return null;
}

function isMissingModelEndpoint(error: unknown): boolean {
  return error instanceof UpstreamStatusError && (error.status === 404 || error.status === 405);
}

function modelFetchError(error: unknown): string {
  if (error instanceof UpstreamStatusError) {
    if (error.status === 401 || error.status === 403) {
      return `认证失败，状态码 ${error.status}`;
    }

    return `状态码 ${error.status}`;
  }

  return summaryForError(error);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
