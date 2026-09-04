import type { IncomingHttpHeaders } from "node:http";
import type {
  ClaudeScene,
  ClaudeSceneTarget,
  ClaudeModelMapRole,
  CompactGateConfig
} from "../shared/types.js";
import type { ClientIdentityStore } from "./client-identity-store.js";
import { factoryClientUserAgent } from "./config-defaults.js";
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
import { buildUpstreamUrlWithMode } from "./upstream-url.js";

export const MIMO_IMAGE_INPUT_MODEL = "mimo-v2.5";
const MIMO_IMAGE_INPUT_HOSTNAME = "token-plan-sgp.xiaomimimo.com";

/**
 * Anthropic models that take effort-based thinking (`output_config.effort` with
 * `thinking.type: "adaptive"`) instead of the older `thinking.budget_tokens`
 * dial. Matches the family generation, so `sonnet-4-5` stays budget-based.
 */
const CLAUDE_EFFORT_THINKING_MODEL = /(?:opus|sonnet|haiku|fable)-5\b|opus-4-8\b/i;
/** Anthropic's floor for `thinking.budget_tokens`, which must also stay under `max_tokens`. */
const CLAUDE_MIN_THINKING_BUDGET = 1024;


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

/**
 * Same identity gate the Codex probe faces (see `CODEX_CLIENT_IDENTITY` in
 * `openai-models.ts`): a relay that whitelists clients answers 401 without a
 * recognised `user-agent`, and neither `x-app` nor `anthropic-beta` satisfies it
 * on their own. `extra_headers` still overrides every entry here.
 */
const CLAUDE_CLIENT_IDENTITY: Record<string, string> = {
  accept: "application/json",
  "anthropic-version": "2023-06-01",
  "user-agent": factoryClientUserAgent("claude"),
  "x-app": "cli"
};

export async function fetchClaudeModels(
  config: CompactGateConfig,
  clientIdentity?: ClientIdentityStore
): Promise<UpstreamModelsResponse> {
  const auth = resolveClaudeCredential(config);
  const headers = buildAnthropicUpstreamHeaders(
    {
      ...CLAUDE_CLIENT_IDENTITY,
      "user-agent": clientIdentity?.userAgentFor("claude") ?? CLAUDE_CLIENT_IDENTITY["user-agent"]
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
  return buildUpstreamUrlWithMode(baseUrl, requestPath, search, "append-request-path");
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

  for (const role of classifyClaudeModelRoles(sourceModel)) {
    const roleTarget = readTrimmedString(config.claude.model_map[role]);
    if (roleTarget) {
      return roleTarget;
    }
  }

  return readTrimmedString(config.claude.model_map.default);
}

/**
 * Rewrites the request model, and on a native Anthropic upstream also carries
 * the client's thinking level across that rewrite. `alignThinking` must stay
 * false when the body is headed for an OpenAI-protocol conversion, which does
 * its own thinking translation and rejects `output_config`.
 */
export function rewriteClaudeModelBody(
  rawBody: Buffer,
  modelOverride: string,
  alignThinking = false
): Buffer {
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
    ...(alignThinking ? alignClaudeThinkingToModel(parsed, model) : {}),
    model
  }));
}

/**
 * Carries the thinking level the client asked for across a model rewrite, in
 * whichever direction the rewrite crossed. A `thinking.budget_tokens` dial means
 * nothing to an effort-based target model and an `output_config.effort` tier
 * means nothing to a budget-based one, so translate between the two and leave a
 * request that already speaks the target's dialect alone.
 */
function alignClaudeThinkingToModel(
  parsed: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  if (!isRecord(parsed.thinking)) {
    return {};
  }

  const type = readTrimmedString(parsed.thinking.type)?.toLowerCase();
  if (type === "disabled") {
    return {};
  }

  return CLAUDE_EFFORT_THINKING_MODEL.test(model)
    ? budgetThinkingToEffort(parsed, parsed.thinking, type)
    : effortThinkingToBudget(parsed, type);
}

function budgetThinkingToEffort(
  parsed: Record<string, unknown>,
  thinking: Record<string, unknown>,
  type: string | undefined
): Record<string, unknown> {
  if (isRecord(parsed.output_config) || type !== "enabled") {
    return {};
  }

  const budget = thinking.budget_tokens;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return {};
  }

  return {
    thinking: { type: "adaptive" },
    output_config: { effort: claudeEffortForThinkingBudget(budget, parsed.max_tokens) }
  };
}

/**
 * The effort dialect carries no token count, so the budget a budget-based model
 * needs is reconstructed from the tier's share of the output ceiling. Anthropic
 * requires at least 1024 thinking tokens and a budget below `max_tokens`.
 */
function effortThinkingToBudget(
  parsed: Record<string, unknown>,
  type: string | undefined
): Record<string, unknown> {
  const effort = isRecord(parsed.output_config)
    ? readTrimmedString(parsed.output_config.effort)?.toLowerCase()
    : null;
  if (type !== "adaptive" && !effort) {
    return {};
  }

  const maxTokens = typeof parsed.max_tokens === "number" && Number.isFinite(parsed.max_tokens)
    ? parsed.max_tokens
    : 32000;
  if (maxTokens <= CLAUDE_MIN_THINKING_BUDGET) {
    // Both constraints cannot hold at this ceiling. Any budget we could emit
    // would be rejected with a 400, and so would the client's own
    // `{type:"adaptive"}` on a budget-based target — so drop the thinking block
    // outright rather than only the effort dial, and let the request through
    // without thinking instead of failing it entirely.
    return { thinking: undefined, output_config: undefined };
  }

  const budget = Math.max(CLAUDE_MIN_THINKING_BUDGET, Math.min(
    maxTokens - 1,
    Math.round(maxTokens * claudeThinkingShareForEffort(effort))
  ));

  return {
    thinking: { type: "enabled", budget_tokens: budget },
    output_config: undefined
  };
}

/**
 * ponytail: the reserved budget share is the only level signal a budget-based
 * client sends, so the tier is a ratio heuristic. Swap in a lookup table if the
 * exact budget ladder each client uses becomes known.
 */
function claudeEffortForThinkingBudget(budget: number, maxTokens: unknown): string {
  const ceiling = typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
    ? maxTokens
    : budget;
  const share = budget / ceiling;
  if (share >= 0.75) {
    return "max";
  }
  if (share >= 0.5) {
    return "high";
  }
  if (share >= 0.25) {
    return "medium";
  }
  return "low";
}

function claudeThinkingShareForEffort(effort: string | null | undefined): number {
  switch (effort) {
    case "minimal":
      return 0.05;
    case "low":
      return 0.15;
    case "medium":
      return 0.375;
    case "high":
      return 0.625;
    default:
      return 1;
  }
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
  if (isClaudeThinkingRequested(parsed.thinking)) {
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

/**
 * A `thinking` block only means thinking is on when it is not explicitly
 * disabled, matching how the protocol converters read the same field. Clients
 * that turn thinking off still send the block, so presence alone says nothing.
 */
function isClaudeThinkingRequested(value: unknown): boolean {
  return isRecord(value) && readTrimmedString(value.type)?.toLowerCase() !== "disabled";
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
  return measureClaudeText(value, (text) => Buffer.byteLength(text));
}

/**
 * Walks the text-bearing parts of an Anthropic request body, skipping image
 * payloads and structural keys, and sums whatever `measure` reports.
 */
export function measureClaudeText(value: unknown, measure: (text: string) => number): number {
  if (typeof value === "string") {
    return measure(value);
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + measureClaudeText(item, measure), 0);
  }
  if (!isRecord(value) || readTrimmedString(value.type)?.toLowerCase() === "image") {
    return 0;
  }

  return Object.entries(value).reduce(
    (total, [key, item]) => total + (
      key === "data" || key === "type" || key === "role" || key === "media_type"
        ? 0
        : measureClaudeText(item, measure)
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

/**
 * Returns every role a model id plausibly belongs to, most specific first. A
 * relay id like `claude-3-7-sonnet-20250219-thinking` is both a reasoning model
 * and a sonnet, so the caller can honour a configured `reasoning` mapping while
 * still falling back to the family instead of straight to `default`.
 */
function classifyClaudeModelRoles(sourceModel: string | null): ClaudeModelMapRole[] {
  const normalized = sourceModel?.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const roles: ClaudeModelMapRole[] = [];
  if (normalized.includes("subagent")) {
    roles.push("subagent");
  }

  if (normalized.includes("reasoning") || normalized.includes("thinking")) {
    roles.push("reasoning");
  }

  if (normalized.includes("haiku")) {
    roles.push("haiku");
  }

  if (normalized.includes("sonnet")) {
    roles.push("sonnet");
  }

  if (normalized === "opusplan" || normalized.includes("opus")) {
    roles.push("opus");
  }

  if (normalized === "default" || normalized === "best") {
    roles.push("default");
  }

  return roles;
}
