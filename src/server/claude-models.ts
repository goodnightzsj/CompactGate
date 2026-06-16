import type { IncomingHttpHeaders } from "node:http";
import type {
  ClaudeModelMapRole,
  CompactGateConfig
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
import { hostOrNull } from "./health.js";
import {
  buildUpstreamHeaders,
  isRecord,
  parseJsonRecord,
  summaryForError
} from "./http-utils.js";
import {
  requestJson,
  UpstreamStatusError
} from "./upstream-client.js";

export type FetchClaudeModels = (config: CompactGateConfig) => Promise<{
  models: string[];
  upstream_host: string;
  error: string | null;
}>;

export const MIMO_IMAGE_INPUT_MODEL = "mimo-v2.5";
const MIMO_IMAGE_INPUT_HOSTNAME = "token-plan-sgp.xiaomimimo.com";
const HUB_DS_PROFILE_NAME = "hub ds";
const HUB_DS_MAX_EFFORT = "max";
const HUB_DS_SAFE_EFFORT = "high";

export async function fetchClaudeModels(config: CompactGateConfig): Promise<{
  models: string[];
  upstream_host: string;
  error: string | null;
}> {
  const upstreams = buildClaudeModelListUrls(config.claude.primary.base_url);
  const auth = resolveClaudeCredential(config);
  const headers = buildAnthropicUpstreamHeaders(
    {
      "anthropic-version": "2023-06-01"
    },
    auth.apiKey
  );
  const errors: string[] = [];

  for (const upstream of upstreams) {
    try {
      const body = await requestJson(upstream, headers, config.timeouts.claude_ms);
      return {
        models: extractModelIds(body),
        upstream_host: upstream.host,
        error: null
      };
    } catch (error) {
      errors.push(`${upstream.pathname}: ${claudeModelFetchError(error)}`);

      if (!shouldTryNextClaudeModelsPath(error)) {
        break;
      }
    }
  }

  return {
    models: [],
    upstream_host: upstreams[0]?.host ?? hostOrNull(config.claude.primary.base_url) ?? "",
    error: `上游模型列表不可用。已尝试 ${errors.join("；")}`
  };
}

export function buildAnthropicUpstreamHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null
): Record<string, string> {
  const next = buildUpstreamHeaders(headers, null);

  if (apiKey) {
    next.authorization = `Bearer ${apiKey}`;
    next["x-api-key"] = apiKey;
    next["anthropic-api-key"] = apiKey;
  }

  return next;
}

export function buildClaudeUpstreamUrl(baseUrl: string, requestPath: string, search = ""): URL {
  const base = new URL(baseUrl);
  const cleanBasePath = base.pathname.replace(/\/+$/, "");
  const cleanRequestPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;

  base.pathname = `${cleanBasePath}${cleanRequestPath}`.replace(/\/{2,}/g, "/");
  base.search = search;
  return base;
}

export function resolveClaudeCredential(config: CompactGateConfig) {
  return resolveRouteCredential("claude_primary", config);
}

export function resolveClaudeMappedModel(
  sourceModel: string | null,
  config: CompactGateConfig,
  rawBody?: Buffer
): string | null {
  if (rawBody && isMimoClaudeUpstreamHost(config) && hasClaudeImageInput(rawBody)) {
    return MIMO_IMAGE_INPUT_MODEL;
  }

  const role = classifyClaudeModelRole(sourceModel);
  const roleTarget = role ? readStringField(config.claude.model_map[role]) : null;
  if (roleTarget) {
    return roleTarget;
  }

  return readStringField(config.claude.model_map.default);
}

export function rewriteClaudeModelBody(
  rawBody: Buffer,
  modelOverride: string,
  config?: CompactGateConfig
): Buffer {
  const model = readStringField(modelOverride);
  const shouldClampHubDsEffort = Boolean(config && isActiveClaudeProfileNamed(config, HUB_DS_PROFILE_NAME));
  const parsed = parseJsonRecord(rawBody);
  if (!parsed) {
    return rawBody;
  }

  const next = { ...parsed };
  let rewritten = false;

  if (model) {
    next.model = model;
    rewritten = true;
  }

  if (shouldClampHubDsEffort && clampOutputConfigEffort(next, HUB_DS_MAX_EFFORT, HUB_DS_SAFE_EFFORT)) {
    rewritten = true;
  }

  return rewritten ? Buffer.from(JSON.stringify(next)) : rawBody;
}

function isMimoClaudeUpstreamHost(config: CompactGateConfig): boolean {
  try {
    return new URL(config.claude.primary.base_url).hostname.toLowerCase() === MIMO_IMAGE_INPUT_HOSTNAME;
  } catch {
    return false;
  }
}

function isActiveClaudeProfileNamed(config: CompactGateConfig, name: string): boolean {
  const state = config.profile_scopes?.claude;
  const activeProfileId = state?.active_profile_id;
  if (!activeProfileId) {
    return false;
  }

  const activeProfile = state?.profiles?.find((profile) => profile.id === activeProfileId);
  return activeProfile?.name.trim().toLowerCase() === name;
}

function clampOutputConfigEffort(
  body: Record<string, unknown>,
  sourceEffort: string,
  targetEffort: string
): boolean {
  if (!isRecord(body.output_config)) {
    return false;
  }

  if (readStringField(body.output_config.effort)?.toLowerCase() !== sourceEffort) {
    return false;
  }

  body.output_config = {
    ...body.output_config,
    effort: targetEffort
  };
  return true;
}

function hasClaudeImageInput(rawBody: Buffer): boolean {
  const parsed = parseJsonRecord(rawBody);
  return Array.isArray(parsed?.messages) && parsed.messages.some((message) =>
    isRecord(message) && containsClaudeImageContent(message.content)
  );
}

function containsClaudeImageContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsClaudeImageContent);
  }

  if (!isRecord(value)) {
    return false;
  }

  if (readStringField(value.type)?.toLowerCase() === "image") {
    return true;
  }

  return Object.hasOwn(value, "content") && containsClaudeImageContent(value.content);
}

function classifyClaudeModelRole(sourceModel: string | null): ClaudeModelMapRole | null {
  const normalized = sourceModel?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "subagent" || normalized.includes("subagent")) {
    return "subagent";
  }

  if (normalized === "reasoning" || normalized.includes("reasoning") || normalized.includes("thinking")) {
    return "reasoning";
  }

  if (normalized === "haiku" || normalized.includes("haiku")) {
    return "haiku";
  }

  if (normalized === "sonnet" || normalized.includes("sonnet")) {
    return "sonnet";
  }

  if (normalized === "opus" || normalized === "opusplan" || normalized.includes("opus")) {
    return "opus";
  }

  if (normalized === "default" || normalized === "best") {
    return "default";
  }

  return null;
}

function buildClaudeModelListUrls(baseUrl: string): URL[] {
  const candidates = [
    buildClaudeUpstreamUrl(baseUrl, "/v1/models"),
    buildClaudeUpstreamUrl(baseUrl, "/models")
  ];
  const rootBase = new URL(baseUrl);
  rootBase.pathname = "/";
  rootBase.search = "";
  rootBase.hash = "";
  candidates.push(
    buildClaudeUpstreamUrl(rootBase.toString(), "/v1/models"),
    buildClaudeUpstreamUrl(rootBase.toString(), "/models")
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

function shouldTryNextClaudeModelsPath(error: unknown): boolean {
  if (error instanceof UpstreamStatusError) {
    return error.status === 404 || error.status === 405;
  }

  return false;
}

function claudeModelFetchError(error: unknown): string {
  if (error instanceof UpstreamStatusError) {
    if (error.status === 401 || error.status === 403) {
      return `认证失败，状态码 ${error.status}`;
    }

    return `状态码 ${error.status}`;
  }

  return summaryForError(error);
}

function extractModelIds(value: unknown): string[] {
  const models = new Set<string>();
  const candidates = isRecord(value) && Array.isArray(value.data) ? value.data : Array.isArray(value) ? value : [];

  for (const item of candidates) {
    if (typeof item === "string") {
      models.add(item);
      continue;
    }

    if (!isRecord(item)) {
      continue;
    }

    const id = readStringField(item.id) ?? readStringField(item.name) ?? readStringField(item.model);
    if (id) {
      models.add(id);
    }
  }

  return [...models].sort((left, right) => left.localeCompare(right));
}

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
