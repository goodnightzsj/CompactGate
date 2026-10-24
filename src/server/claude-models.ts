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
import type { OAuthStore } from "./oauth-store.js";
import { fetchOAuthModels } from "./oauth-transport.js";
import { ProtocolConversionError } from "./protocol-conversion.js";

export const MIMO_IMAGE_INPUT_MODEL = "mimo-v2.5";
const MIMO_IMAGE_INPUT_HOSTNAME = "token-plan-sgp.xiaomimimo.com";

/** Floor for reconstructed manual budgets; generated budgets stay below max_tokens. */
const CLAUDE_MIN_THINKING_BUDGET = 1024;

interface ClaudeThinkingCapabilities {
  modes: readonly string[];
  efforts: readonly string[];
}

const BUDGET_THINKING = { modes: ["enabled"], efforts: [] };
const BUDGET_WITH_EFFORT = { modes: ["enabled"], efforts: ["low", "medium", "high"] };
const ADAPTIVE_THINKING = { modes: ["adaptive"], efforts: ["low", "medium", "high", "xhigh", "max"] };
const DUAL_THINKING = { modes: ["enabled", "adaptive"], efforts: ["low", "medium", "high", "max"] };

// Verified 2026-10-25: https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
// Effort is independent of thinking mode (notably Opus 4.5); never infer future IDs or relay aliases.
const CLAUDE_THINKING_CAPABILITIES: ReadonlyMap<string, ClaudeThinkingCapabilities> = new Map([
  ["claude-sonnet-4-5", BUDGET_THINKING],
  ["claude-sonnet-4-5-20250929", BUDGET_THINKING],
  ["claude-haiku-4-5", BUDGET_THINKING],
  ["claude-haiku-4-5-20251001", BUDGET_THINKING],
  ["claude-opus-4-5", BUDGET_WITH_EFFORT],
  ["claude-opus-4-5-20251101", BUDGET_WITH_EFFORT],
  ["claude-opus-4-6", DUAL_THINKING],
  ["claude-sonnet-4-6", DUAL_THINKING],
  ["claude-mythos-preview", DUAL_THINKING],
  ["claude-opus-4-7", ADAPTIVE_THINKING],
  ["claude-opus-4-8", ADAPTIVE_THINKING],
  ["claude-opus-5", ADAPTIVE_THINKING],
  ["claude-opus-5-5", ADAPTIVE_THINKING],
  ["claude-sonnet-5", ADAPTIVE_THINKING],
  ["claude-sonnet-5-5", ADAPTIVE_THINKING],
  ["claude-haiku-5-5", ADAPTIVE_THINKING],
  ["claude-fable-5", ADAPTIVE_THINKING],
  ["claude-fable-5-1", ADAPTIVE_THINKING],
  ["claude-mythos-5", ADAPTIVE_THINKING],
  ["claude-mythos-5-1", ADAPTIVE_THINKING]
]);

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
  "x-app": "cli"
};

export async function fetchClaudeModels(
  config: CompactGateConfig,
  clientIdentity?: ClientIdentityStore,
  oauth?: OAuthStore
): Promise<UpstreamModelsResponse> {
  const auth = resolveClaudeCredential(config);
  const identityKind = config.claude.primary.upstream_protocol === "anthropic_messages" ? "claude" : "codex";
  const userAgent = clientIdentity
    ? clientIdentity.userAgentFor(identityKind)
    : factoryClientUserAgent(identityKind);
  if (config.claude.primary.oauth_account_id) return fetchOAuthModels(config.claude.primary, oauth, config.timeouts.claude_ms, userAgent);
  const headers = buildAnthropicUpstreamHeaders(
    {
      ...CLAUDE_CLIENT_IDENTITY,
      ...(userAgent ? { "user-agent": userAgent } : {})
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
 * Upstream hosts observed to reject a rewritten request that still carries
 * Claude Code's `tool_reference` blocks. Each entry needs a confirmed repro —
 * the same body 502s with the block and 200s with it replaced — because the
 * fix changes what the model is shown, and doing that to a host that never
 * complained would be a silent behaviour change with no evidence behind it.
 *
 * Hosts absent from this list keep the block: on a relay that passes it through
 * untouched, it is the accurate record of which tools were loaded.
 */
export const TOOL_REFERENCE_STRIPPING_HOSTS = ["opencode.9962510.xyz"];

/**
 * Suffix match so a relay reached through an alternate subdomain still counts —
 * the same rule `HOST_QUIRKS` and the proxy agent use.
 */
export function hostNeedsToolReferenceStripping(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return TOOL_REFERENCE_STRIPPING_HOSTS.some(
    (candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`)
  );
}

/**
 * Rewrites only the model by default. The caller may supply the final native
 * Messages endpoint for verified, necessary thinking adaptation. OpenAI and
 * count_tokens callers omit it: their protocol handling owns those fields.
 *
 * `tool_reference` stripping is separate and host-scoped (see
 * `stripClaudeToolReferenceBlocks`), applied by the caller once the upstream
 * host is final — the scene routing can swap in a profile with another
 * base_url, so the rewrite alone cannot know which host will receive it.
 */
export function rewriteClaudeModelBody(
  rawBody: Buffer,
  modelOverride: string,
  thinkingUpstream?: URL
): Buffer {
  const model = readTrimmedString(modelOverride);
  if (!model) {
    return rawBody;
  }

  const parsed = parseJsonRecord(rawBody);
  if (!parsed || parsed.model === model) {
    return rawBody;
  }

  return Buffer.from(JSON.stringify({
    ...parsed,
    ...(thinkingUpstream && typeof parsed.model === "string"
      ? alignClaudeThinkingToModel(parsed, model, thinkingUpstream) : {}),
    model
  }));
}

/**
 * Replaces Claude Code's `tool_reference` blocks with the referenced tool names.
 * Returns `body` unchanged when there are none, so a body this does not apply to
 * is not re-serialised.
 */
export function stripClaudeToolReferenceBlocks(body: Buffer): Buffer {
  const parsed = parseJsonRecord(body);
  if (!parsed) {
    return body;
  }

  const messages = replaceClaudeToolReferenceBlocks(parsed.messages);
  if (!messages) {
    return body;
  }

  return Buffer.from(JSON.stringify({ ...parsed, messages }));
}

/**
 * Claude Code answers a ToolSearch / deferred-tool turn with `tool_reference`
 * blocks inside `tool_result.content`. Anthropic accepts those only for a model
 * that knows the referenced tools; every relay this proxy fronts rewrites the
 * model to a vendor one instead, and the relay answers HTTP 502 (or an
 * in-stream "all upstream models failed") for as long as the block stays in the
 * conversation — which is every later turn, so a single ToolSearch wedges the
 * whole session. Measured against opencode: the identical body with the block
 * replaced by text returns 200, with the block present 502, deterministically.
 *
 * The referenced tool is always one the request already declares in `tools`, so
 * the block carries no information the model is not already given. Replacing it
 * with the tool's name keeps the tool-use exchange well-formed — a `tool_result`
 * cannot be emptied — without inventing a capability claim.
 */
function replaceClaudeToolReferenceBlocks(messages: unknown): unknown[] | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  let changed = false;
  const next = messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      return message;
    }
    let messageChanged = false;
    const content = message.content.map((block) => {
      if (!isRecord(block) || block.type !== "tool_result" || !Array.isArray(block.content)) {
        return block;
      }
      const text = block.content
        .filter((nested) => isRecord(nested) && nested.type === "tool_reference")
        .map((nested) => readTrimmedString((nested as Record<string, unknown>).tool_name))
        .filter((name): name is string => Boolean(name))
        .join("\n");
      if (!text) {
        return block;
      }
      const remaining = block.content.filter(
        (nested) => !(isRecord(nested) && nested.type === "tool_reference")
      );
      messageChanged = true;
      return { ...block, content: [...remaining, { type: "text", text }] };
    });
    if (!messageChanged) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });
  return changed ? next : null;
}

/** Only an incompatible mode on a verified endpoint/model warrants rewriting client intent. */
function alignClaudeThinkingToModel(
  parsed: Record<string, unknown>,
  model: string,
  upstream: URL
): Record<string, unknown> {
  if (upstream.origin !== "https://api.anthropic.com" || upstream.pathname !== "/v1/messages") {
    return {};
  }
  const capabilities = CLAUDE_THINKING_CAPABILITIES.get(model);
  if (!capabilities || !isRecord(parsed.thinking)) {
    return {};
  }
  const thinking = parsed.thinking;
  const type = thinking.type;
  if ((type !== "enabled" && type !== "adaptive") || capabilities.modes.includes(type)) {
    return {};
  }
  if (parsed.output_config !== undefined && !isRecord(parsed.output_config)) {
    throw new ProtocolConversionError("Thinking adaptation requires output_config to be an object.");
  }
  const output = isRecord(parsed.output_config) ? { ...parsed.output_config } : {};
  const effort = output.effort;
  if (effort !== undefined && capabilities.efforts.length > 0 &&
    (typeof effort !== "string" || !capabilities.efforts.includes(effort))) {
    throw new ProtocolConversionError(`Thinking adaptation encountered an unsupported output_config.effort for ${model}.`);
  }
  const maxTokens = parsed.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new ProtocolConversionError("Thinking adaptation requires an explicit positive integer max_tokens.");
  }
  return type === "enabled"
    ? budgetThinkingToEffort(thinking, output, maxTokens)
    : effortThinkingToBudget(thinking, output, capabilities, maxTokens);
}

function budgetThinkingToEffort(
  thinking: Record<string, unknown>,
  output: Record<string, unknown>,
  maxTokens: number
): Record<string, unknown> {
  const budget = thinking.budget_tokens;
  if (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < CLAUDE_MIN_THINKING_BUDGET) {
    throw new ProtocolConversionError("Thinking adaptation requires an integer thinking.budget_tokens of at least 1024.");
  }
  const nextThinking: Record<string, unknown> = { ...thinking, type: "adaptive" };
  delete nextThinking.budget_tokens;
  return {
    thinking: nextThinking,
    output_config: { ...output, effort: output.effort ?? claudeEffortForThinkingBudget(budget, maxTokens) }
  };
}

function effortThinkingToBudget(
  thinking: Record<string, unknown>,
  output: Record<string, unknown>,
  capabilities: ClaudeThinkingCapabilities,
  maxTokens: number
): Record<string, unknown> {
  if (thinking.budget_tokens !== undefined) {
    throw new ProtocolConversionError("Cannot adapt ambiguous thinking with both adaptive mode and budget_tokens.");
  }
  if (maxTokens <= CLAUDE_MIN_THINKING_BUDGET) {
    throw new ProtocolConversionError("Thinking adaptation needs max_tokens > 1024; it will not silently disable thinking.");
  }
  // shortcut: legacy budget/effort ratios are approximate; replace only with a verified target-specific mapping.
  const budget = Math.max(CLAUDE_MIN_THINKING_BUDGET, Math.min(
    maxTokens - 1,
    Math.round(maxTokens * claudeThinkingShareForEffort(output.effort))
  ));
  if (capabilities.efforts.length === 0) delete output.effort;
  return {
    thinking: { ...thinking, type: "enabled", budget_tokens: budget },
    output_config: Object.keys(output).length > 0 ? output : undefined
  };
}

// shortcut: the budget ratio approximates effort, not an equivalent hard cap; retain explicit effort when available.
function claudeEffortForThinkingBudget(budget: number, maxTokens: number): string {
  const share = budget / maxTokens;
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

function claudeThinkingShareForEffort(effort: unknown): number {
  switch (effort) {
    case "minimal":
      return 0.05;
    case "low":
      return 0.15;
    case "medium":
      return 0.375;
    case "high":
      return 0.625;
    case "xhigh":
    case "max":
      return 1;
    default:
      throw new ProtocolConversionError("Budget thinking adaptation requires an explicit supported output_config.effort.");
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
