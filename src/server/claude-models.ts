import type { IncomingHttpHeaders } from "node:http";
import type {
  ClaudeScene,
  ClaudeSceneTarget,
  ClaudeModelMapRole,
  CompactGateConfig
} from "../shared/types.js";
import { resolveRouteCredential } from "./credentials.js";
import {
  buildUpstreamHeaders,
  isRecord,
  parseJsonRecord,
  readTrimmedString
} from "./http-utils.js";
import { applyProfile } from "./config-profile-mutations.js";
import { getProfileScopeState } from "./config-profile-scope.js";
import { resolveRequestScopedProfile } from "./request-profile.js";
import {
  fetchUpstreamModels,
  type UpstreamModelsResponse
} from "./upstream-models.js";
import { resolveUpstreamPath } from "./upstream-url.js";

export const MIMO_IMAGE_INPUT_MODEL = "mimo-v2.5";
const MIMO_IMAGE_INPUT_HOSTNAME = "token-plan-sgp.xiaomimimo.com";

export interface ClaudeSceneDetection {
  scene: ClaudeScene;
  text_bytes: number;
}

export interface ClaudeRequestRouting {
  config: CompactGateConfig;
  scene: ClaudeScene;
  textBytes: number;
  profileId: string | null;
  profileName: string | null;
  profileSource: "explicit" | "scene" | "active";
  sceneModel: string | null;
}

export async function fetchClaudeModels(config: CompactGateConfig): Promise<UpstreamModelsResponse> {
  const auth = resolveClaudeCredential(config);
  const headers = buildAnthropicUpstreamHeaders(
    {
      "anthropic-version": "2023-06-01"
    },
    auth.apiKey,
    config.claude.primary.extra_headers
  );
  return fetchUpstreamModels({
    baseUrl: config.claude.primary.base_url,
    headers,
    proxyUrl: config.claude.primary.proxy_url,
    timeoutMs: config.timeouts.claude_ms
  });
}

export function buildAnthropicUpstreamHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null,
  extraHeaders: Record<string, string> = {}
): Record<string, string> {
  const next = buildUpstreamHeaders(headers, null, extraHeaders);

  if (apiKey) {
    next.authorization = `Bearer ${apiKey}`;
    next["x-api-key"] = apiKey;
    next["anthropic-api-key"] = apiKey;
  }

  return next;
}

export function buildClaudeUpstreamUrl(baseUrl: string, requestPath: string, search = ""): URL {
  const base = new URL(baseUrl);
  base.pathname = resolveUpstreamPath(base.pathname, requestPath, "append-request-path");
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
  const roleTarget = role ? readTrimmedString(config.claude.model_map[role]) : null;
  if (roleTarget) {
    return roleTarget;
  }

  return readTrimmedString(config.claude.model_map.default);
}

export function rewriteClaudeModelBody(rawBody: Buffer, modelOverride: string): Buffer {
  const model = readTrimmedString(modelOverride);
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

export function detectClaudeScene(
  rawBody: Buffer,
  sourceModel: string | null,
  longContextBytes: number
): ClaudeSceneDetection {
  const parsed = parseJsonRecord(rawBody);
  if (!parsed) {
    return { scene: "default", text_bytes: 0 };
  }

  const textBytes = [parsed.system, parsed.messages, parsed.tools]
    .reduce<number>((total, value) => total + countClaudeTextBytes(value), 0);
  if (longContextBytes > 0 && textBytes >= longContextBytes) {
    return { scene: "long_context", text_bytes: textBytes };
  }
  if (sourceModel?.toLowerCase().includes("haiku")) {
    return { scene: "background", text_bytes: textBytes };
  }
  if (
    Array.isArray(parsed.tools) &&
    parsed.tools.some((tool) =>
      isRecord(tool) && readTrimmedString(tool.type)?.toLowerCase().startsWith("web_search")
    )
  ) {
    return { scene: "web_search", text_bytes: textBytes };
  }
  if (parsed.thinking !== null && parsed.thinking !== undefined) {
    return { scene: "thinking", text_bytes: textBytes };
  }
  if (hasClaudeImageInput(rawBody)) {
    return { scene: "image", text_bytes: textBytes };
  }
  return { scene: "default", text_bytes: textBytes };
}

export function resolveClaudeSceneTarget(
  scene: ClaudeScene,
  config: CompactGateConfig
): ClaudeSceneTarget {
  return { ...config.claude.scene_map[scene] };
}

export function resolveClaudeRequestRouting(
  config: CompactGateConfig,
  rawBody: Buffer,
  sourceModel: string | null,
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined
): ClaudeRequestRouting {
  const detection = detectClaudeScene(rawBody, sourceModel, config.claude.long_context_bytes);
  const explicit = resolveRequestScopedProfile(
    config,
    "claude",
    headers,
    remoteAddress
  );
  if (explicit) {
    return {
      config: explicit.config,
      scene: detection.scene,
      textBytes: detection.text_bytes,
      profileId: explicit.profileId,
      profileName: explicit.profileName,
      profileSource: "explicit",
      sceneModel: null
    };
  }

  const target = resolveClaudeSceneTarget(detection.scene, config);
  const targetProfileId = readTrimmedString(target.profile_id);
  const targetModel = readTrimmedString(target.model);
  if (targetProfileId) {
    const profile = getProfileScopeState(config, "claude").profiles.find(
      (candidate) => candidate.id === targetProfileId
    );
    return {
      config: applyProfile(config, "claude", targetProfileId),
      scene: detection.scene,
      textBytes: detection.text_bytes,
      profileId: targetProfileId,
      profileName: profile?.name ?? null,
      profileSource: "scene",
      sceneModel: targetModel
    };
  }

  const activeProfileId = config.profile_scopes?.claude?.active_profile_id ?? null;
  const activeProfile = getProfileScopeState(config, "claude").profiles.find(
    (candidate) => candidate.id === activeProfileId
  );
  return {
    config,
    scene: detection.scene,
    textBytes: detection.text_bytes,
    profileId: activeProfileId,
    profileName: activeProfile?.name ?? null,
    profileSource: targetModel ? "scene" : "active",
    sceneModel: targetModel
  };
}

function isMimoClaudeUpstreamHost(config: CompactGateConfig): boolean {
  return URL.parse(config.claude.primary.base_url)?.hostname.toLowerCase() === MIMO_IMAGE_INPUT_HOSTNAME;
}

export function hasClaudeImageInput(rawBody: Buffer): boolean {
  const parsed = parseJsonRecord(rawBody);
  return Array.isArray(parsed?.messages) && parsed.messages.some((message) =>
    isRecord(message) && containsClaudeImageContent(message.content)
  );
}

function countClaudeTextBytes(value: unknown): number {
  if (typeof value === "string") {
    return Buffer.byteLength(value);
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countClaudeTextBytes(item), 0);
  }
  if (!isRecord(value) || readTrimmedString(value.type)?.toLowerCase() === "image") {
    return 0;
  }

  return Object.entries(value).reduce(
    (total, [key, item]) => total + (
      key === "data" || key === "type" || key === "role" || key === "media_type"
        ? 0
        : countClaudeTextBytes(item)
    ),
    0
  );
}

function containsClaudeImageContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsClaudeImageContent);
  }

  if (!isRecord(value)) {
    return false;
  }

  if (readTrimmedString(value.type)?.toLowerCase() === "image") {
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
