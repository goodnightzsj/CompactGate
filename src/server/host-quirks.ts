import { appendHeaderToken, parseJsonRecord } from "./http-utils.js";
import { measureClaudeText } from "./claude-models.js";

/**
 * Per-upstream-host request fixups.
 *
 * Some third-party relays reject otherwise valid requests unless a vendor
 * specific header is present. Each quirk is a self-contained entry in
 * HOST_QUIRKS; adding a new host means appending one object here.
 */
export interface HostQuirkContext {
  host: string;
  sourceModel: string | null;
  targetModel: string | null;
  headers: Record<string, string>;
}

export interface HostQuirk {
  id: string;
  matches: (context: HostQuirkContext) => boolean;
  apply: (context: HostQuirkContext) => void;
}

const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";

export const HOST_QUIRKS: HostQuirk[] = [
  {
    // anyrouter serves Opus only on the 1m context tier and rejects requests
    // that omit the beta with HTTP 400 "1m 上下文已经全量可用，请启用 1m 上下文后重试".
    // Claude Code sends the beta on main-session turns but not on background
    // (haiku) turns, which CompactGate may remap onto an Opus target.
    id: "anyrouter-opus-context-1m",
    matches: ({ host, targetModel }) =>
      hostMatchesSuffix(host, "anyrouter.top") && (targetModel ?? "").toLowerCase().includes("opus"),
    apply: ({ headers }) => {
      headers["anthropic-beta"] = appendHeaderToken(headers["anthropic-beta"], ANTHROPIC_CONTEXT_1M_BETA);
    }
  },
  {
    // muyuan rejects requests carrying Codex's responses-lite hint with
    // HTTP 400 "This model is not supported when using
    // X-OpenAI-Internal-Codex-Responses-Lite". The header is only a payload
    // optimisation, so dropping it lets the request through unchanged.
    id: "muyuan-drop-codex-responses-lite",
    matches: ({ host }) => hostMatchesSuffix(host, "muyuan.do"),
    apply: ({ headers }) => {
      delete headers["x-openai-internal-codex-responses-lite"];
    }
  }
];

export function applyHostQuirks(context: HostQuirkContext): string[] {
  const applied: string[] = [];
  for (const quirk of HOST_QUIRKS) {
    if (quirk.matches(context)) {
      quirk.apply(context);
      applied.push(quirk.id);
    }
  }
  return applied;
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === suffix || normalized.endsWith(`.${suffix}`);
}

/**
 * Per-host local responses for endpoints an upstream does not implement.
 *
 * Unlike HOST_QUIRKS these never reach the upstream at all: CompactGate
 * answers on its behalf. Only add a host here once its 404/501 for the
 * endpoint is confirmed in the request log.
 */
export interface HostShortCircuitContext {
  host: string;
  upstreamPath: string;
  rawBody: Buffer;
}

export interface HostShortCircuit {
  id: string;
  matches: (context: HostShortCircuitContext) => boolean;
  respond: (context: HostShortCircuitContext) => unknown;
}

export const HOST_SHORT_CIRCUITS: HostShortCircuit[] = [
  {
    // agentrouter proxies /v1/messages only and answers count_tokens with
    // HTTP 404 "Invalid URL (POST /v1/messages/count_tokens)". Claude Code
    // uses that count for its context gauge and auto-compaction timing, so a
    // local estimate keeps those working instead of failing outright.
    id: "agentrouter-local-count-tokens",
    matches: ({ host, upstreamPath }) =>
      hostMatchesSuffix(host, "agentrouter.org") && isCountTokensPath(upstreamPath),
    respond: ({ rawBody }) => ({ input_tokens: estimateAnthropicInputTokens(rawBody) })
  }
];

export function resolveHostShortCircuit(
  context: HostShortCircuitContext
): { id: string; body: Buffer } | null {
  const shortCircuit = HOST_SHORT_CIRCUITS.find((candidate) => candidate.matches(context));
  if (!shortCircuit) {
    return null;
  }
  return {
    id: shortCircuit.id,
    body: Buffer.from(JSON.stringify(shortCircuit.respond(context)))
  };
}

export function isCountTokensPath(upstreamPath: string): boolean {
  return upstreamPath === "/v1/messages/count_tokens" || upstreamPath === "/messages/count_tokens";
}

/**
 * Rough token estimate from the request's text payload.
 *
 * Anthropic publishes no offline tokenizer, only the heuristic of roughly
 * 3.5 characters per token, which is measured on English and reportedly
 * drifts up to ~20%. CJK fragments into far more tokens per character, so
 * those code points are counted separately at a deliberately conservative
 * 2 characters per token — over-counting makes the context gauge compact a
 * little early rather than overrun the window.
 *
 * ponytail: character heuristic, no BPE and no per-message structural
 * overhead. Swap in a real tokenizer if this ever has to be billable.
 */
export function estimateAnthropicInputTokens(rawBody: Buffer): number {
  const parsed = parseJsonRecord(rawBody);
  if (!parsed) {
    return 0;
  }
  const tokens = [parsed.system, parsed.messages, parsed.tools]
    .reduce<number>((total, value) => total + measureClaudeText(value, estimateTextTokens), 0);
  return Math.ceil(tokens);
}

const CJK_CODE_POINT = /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/u;

function estimateTextTokens(text: string): number {
  let cjkCount = 0;
  let otherCount = 0;
  for (const character of text) {
    if (CJK_CODE_POINT.test(character)) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return cjkCount / 2 + otherCount / 3.5;
}
