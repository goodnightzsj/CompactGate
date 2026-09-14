import type { UpstreamProtocol } from "../shared/types.js";
import { appendHeaderToken, isRecord, parseJsonRecord } from "./http-utils.js";
import { measureClaudeText } from "./claude-models.js";

/**
 * Per-upstream-host request fixups.
 *
 * Some third-party relays reject otherwise valid requests unless a vendor
 * specific header is present, or unless something in the body is rewritten.
 * Each quirk is a self-contained entry in HOST_QUIRKS (headers) or HOST_BODY_QUIRKS
 * (bodies); adding a new host means appending one object to the matching list.
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
    // anyrouter serves every model on the 1m context tier and rejects requests
    // that omit the beta with HTTP 400 "1m 上下文已经全量可用，请启用 1m 上下文后重试".
    // Verified by A/B probe: the same sonnet request 400s without the beta and
    // gets past that check with it. Claude Code only sends the beta on
    // main-session turns, so background and subagent turns need it added.
    id: "anyrouter-context-1m",
    matches: ({ host }) => hostMatchesSuffix(host, "anyrouter.top"),
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
 * Per-host request *body* fixups, the counterpart to HOST_QUIRKS.
 *
 * Separate from HOST_QUIRKS because a body rewrite can only be decided once the
 * upstream host is final: profile and scene routing pick `base_url` after the
 * body is built, so the header pass cannot stand in for it.
 */
export interface HostBodyQuirkContext {
  host: string;
  upstreamProtocol: UpstreamProtocol;
  body: Buffer;
}

export interface HostBodyQuirk {
  id: string;
  matches: (context: HostBodyQuirkContext) => boolean;
  apply: (body: Buffer) => Buffer;
}

export const HOST_BODY_QUIRKS: HostBodyQuirk[] = [
  {
    // agentrouter.org fans one API key across several Azure OpenAI resources and
    // picks one per request, so a turn whose earlier items came from resource A
    // is rejected with HTTP 400 "The requested item was created under a
    // different Azure OpenAI resource" when it lands on B. The error carries
    // `code: null`, so nothing downstream can classify it.
    //
    // Every input item id is scratch state on a `store: false` request — the
    // providers in the capture were served ~3000 times with no ids at all — so
    // dropping them makes the body identical on whichever resource receives it.
    // Reasoning state rides on `encrypted_content`, and tool pairing on
    // `call_id`; neither is touched. `item_reference` carries nothing else and
    // would otherwise dangle, so it goes whole.
    id: "agentrouter-strip-input-item-ids",
    matches: ({ host, upstreamProtocol }) =>
      upstreamProtocol === "openai_responses" && hostMatchesSuffix(host, "agentrouter.org"),
    apply: stripResponsesInputItemIds
  }
];

export function applyHostBodyQuirks(context: HostBodyQuirkContext): string[] {
  const applied: string[] = [];
  let body = context.body;
  let current = context;
  for (const quirk of HOST_BODY_QUIRKS) {
    if (!quirk.matches(current)) {
      continue;
    }
    const next = quirk.apply(body);
    if (next !== body) {
      body = next;
      current = { ...context, body };
      applied.push(quirk.id);
    }
  }
  context.body = body;
  return applied;
}

/**
 * Returns `body` unchanged when there is nothing to strip, so a request this
 * does not apply to is not re-serialised.
 */
function stripResponsesInputItemIds(body: Buffer): Buffer {
  const parsed = parseJsonRecord(body);
  if (!parsed || !Array.isArray(parsed.input)) {
    return body;
  }

  const next: unknown[] = [];
  let changed = false;
  for (const item of parsed.input) {
    if (!isRecord(item)) {
      next.push(item);
      continue;
    }
    if (item.type === "item_reference") {
      changed = true;
      continue;
    }
    if (typeof item.id === "string") {
      const { id: _id, ...rest } = item;
      next.push(rest);
      changed = true;
      continue;
    }
    next.push(item);
  }

  return changed ? Buffer.from(JSON.stringify({ ...parsed, input: next })) : body;
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

// Relays that answer count_tokens with HTTP 404 "Invalid URL". Both were
// observed in the request log; add a host here once its 404 is confirmed.
const COUNT_TOKENS_UNSUPPORTED_HOSTS = ["agentrouter.org", "anyrouter.top"];

export const HOST_SHORT_CIRCUITS: HostShortCircuit[] = [
  {
    // These relays proxy /v1/messages only. Claude Code uses the token count
    // for its context gauge and auto-compaction timing, so a local estimate
    // keeps those working instead of failing outright.
    id: "local-count-tokens",
    matches: ({ host, upstreamPath }) =>
      isCountTokensPath(upstreamPath) &&
      COUNT_TOKENS_UNSUPPORTED_HOSTS.some((candidate) => hostMatchesSuffix(host, candidate)),
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
