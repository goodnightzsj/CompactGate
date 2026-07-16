import type { IncomingHttpHeaders } from "node:http";
import type {
  ClaudeModelMapRole,
  CompactGateConfig
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
import {
  buildUpstreamHeaders,
  isRecord,
  parseJsonRecord
} from "./http-utils.js";
import {
  fetchUpstreamModels,
  type UpstreamModelsResponse
} from "./upstream-models.js";

export type FetchClaudeModels = (config: CompactGateConfig) => Promise<UpstreamModelsResponse>;

export const MIMO_IMAGE_INPUT_MODEL = "mimo-v2.5";
const MIMO_IMAGE_INPUT_HOSTNAME = "token-plan-sgp.xiaomimimo.com";

export async function fetchClaudeModels(config: CompactGateConfig): Promise<UpstreamModelsResponse> {
  const auth = resolveClaudeCredential(config);
  const headers = buildAnthropicUpstreamHeaders(
    {
      "anthropic-version": "2023-06-01"
    },
    auth.apiKey
  );
  return fetchUpstreamModels({
    baseUrl: config.claude.primary.base_url,
    headers,
    timeoutMs: config.timeouts.claude_ms
  });
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

export function rewriteClaudeModelBody(rawBody: Buffer, modelOverride: string): Buffer {
  const model = readStringField(modelOverride);
  if (!model) {
    return rawBody;
  }

  const parsed = parseJsonRecord(rawBody);
  if (!parsed) {
    return rawBody;
  }

  return Buffer.from(JSON.stringify({
    ...parsed,
    model
  }));
}

function isMimoClaudeUpstreamHost(config: CompactGateConfig): boolean {
  try {
    return new URL(config.claude.primary.base_url).hostname.toLowerCase() === MIMO_IMAGE_INPUT_HOSTNAME;
  } catch {
    return false;
  }
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

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
