import type { IncomingHttpHeaders } from "node:http";
import type { ClientIdentityKind } from "../shared/types.js";
import { readHeaderString } from "./http-utils.js";
import { parseCodexClientUserAgent } from "./codex-version.js";

/**
 * Outbound User-Agent rewriting for non-CLI clients.
 *
 * A relay that whitelists official CLIs answers 401 for anything else, so a
 * third-party client routed through CompactGate has to introduce itself the same
 * way the CLI does. Only `user-agent` is ever written — `originator`, `x-app`,
 * `anthropic-beta` and everything else stay exactly as the client sent them,
 * because those carry capability and routing meaning the client owns.
 *
 * A request that already comes from a real CLI is left completely alone: it is
 * already the identity we would otherwise synthesize.
 */

/**
 * Matches `claude-cli/2.1.234 (external, cli)` and the bare `claude-cli/2.1.234`
 * form. Deliberately narrower than a substring check on "claude": the Anthropic
 * SDK's own agent and third-party clients that merely mention Claude are not the
 * CLI and must still be rewritten.
 */
const CLAUDE_CLI_USER_AGENT = /(?:^|\s)claude-cli\/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9.-]*)?)/i;

/** A semver, with an optional prerelease/build variant such as `-cometix`. */
const SEMVER_SOURCE = String.raw`\d+\.\d+\.\d+(?:[-+][A-Za-z0-9][A-Za-z0-9.-]*)?`;

export function isNativeCodexUserAgent(userAgent: string | null): boolean {
  return parseCodexClientUserAgent(userAgent) !== null;
}

export function isNativeClaudeUserAgent(userAgent: string | null): boolean {
  return userAgent !== null && CLAUDE_CLI_USER_AGENT.test(userAgent);
}

export function isNativeCliRequest(
  kind: ClientIdentityKind,
  headers: IncomingHttpHeaders
): boolean {
  const userAgent = readHeaderString(headers["user-agent"]);
  return kind === "codex"
    ? isNativeCodexUserAgent(userAgent)
    : isNativeClaudeUserAgent(userAgent);
}

/**
 * Drops prerelease/build variants from every semver in a UA, so a fork's build
 * tag (`0.144.3-cometix`) does not go out as a version no upstream recognises.
 * The variant appears both in the leading product token and again inside the
 * trailing parenthesised comment, so this rewrites all occurrences.
 */
export function stripUserAgentVariants(userAgent: string): string {
  return userAgent.replace(
    new RegExp(String.raw`(\d+\.\d+\.\d+)(?:[-+][A-Za-z0-9][A-Za-z0-9.-]*)`, "g"),
    "$1"
  );
}

/** The product token a UA leads with, e.g. `codex-tui` in `codex-tui/0.144.3 (…)`. */
export function userAgentProductToken(userAgent: string): string | null {
  return userAgent.match(/^([A-Za-z0-9_.-]+)\//)?.[1] ?? null;
}

/**
 * Replaces the product's own version while leaving every other version in the UA
 * untouched. A full-form Codex UA carries the OS and terminal versions too
 * (`codex-tui/0.144.3 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.3)`),
 * so a global semver replace would claim macOS 0.153.2 and iTerm 0.153.2 — a UA
 * no real client could ever send. Only the two positions bound to the product
 * token are rewritten.
 */
export function swapUserAgentVersion(userAgent: string, version: string): string {
  const token = userAgentProductToken(userAgent);
  if (!token || !isPlainVersion(version)) {
    return userAgent;
  }

  const quoted = escapeRegExp(token);
  return userAgent
    .replace(new RegExp(String.raw`^(${quoted}/)${SEMVER_SOURCE}`), `$1${version}`)
    .replace(new RegExp(String.raw`(\(${quoted};\s*)${SEMVER_SOURCE}`, "g"), `$1${version}`);
}

/**
 * Writes the synthesized identity onto an already-built upstream header set.
 *
 * Called after the protocol-specific header cleanup (which strips `x-codex-*` or
 * `anthropic-*` depending on the target protocol) and before host quirks, so
 * neither can be undone by this. `extra_headers` was already merged by
 * `buildUpstreamHeaders`, so an operator override of `user-agent` must survive:
 * hence `extraHeaderNames`.
 */
export function applyClientIdentityUserAgent(
  headers: Record<string, string>,
  userAgent: string | null,
  extraHeaderNames: readonly string[] = []
): boolean {
  if (!userAgent) {
    return false;
  }
  if (extraHeaderNames.some((name) => name.toLowerCase() === "user-agent")) {
    return false;
  }

  headers["user-agent"] = userAgent;
  return true;
}

function isPlainVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version.trim());
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
