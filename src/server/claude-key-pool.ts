import type { IncomingHttpHeaders } from "node:http";
import type { CompactGateConfig } from "../shared/types.js";
import { enabledApiKeyPool } from "./credentials.js";
import { readTrimmedString } from "./http-utils.js";
import { enforceMaxEntries, rememberMapEntry } from "./primary-failover-limits.js";

/**
 * Claude-scope key pool selection. Codex gets its rotation from
 * `PrimaryFailoverState`; the Claude route has no failover machinery of its
 * own, so this is a deliberately smaller cousin: per-key health, first-failure
 * auth quarantine, Retry-After rate-limit cooldowns, session affinity and the
 * same fill_first / spread order semantics. The routed profile (scene map,
 * explicit header, or active) is chosen exactly as before — this only decides
 * *which key of that profile* carries the request.
 */

const AUTH_QUARANTINE_MS = 30 * 60 * 1000;
const TRANSIENT_THRESHOLD = 3;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const TRANSIENT_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_MS = 10 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const SESSION_STICKY_TTL_MS = 30 * 60 * 1000;
const UNBLOCK_JITTER_MS = 2_000;
/** Same bound the codex stickiness store uses; sessions arrive from clients. */
const MAX_STICKY_ENTRIES = 2_048;

interface ClaudeKeyHealth {
  inFlight: number;
  transientFailures: number;
  quarantineUntil: number;
  rateLimitUntil: number;
  cooldownUntil: number;
  /**
   * Past the cooldown but not yet trusted: `sticky_reserve_seconds` after a 429
   * clears, the key still serves its own pinned sessions and takes no new ones.
   */
  stickyOnlyUntil: number;
  lastSelectedAt: number;
}

interface ClaudeKeySelection {
  keyId: string;
  apiKey: string;
}

export interface ClaudeKeyPoolResult {
  status: number;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs?: number | null;
}

export class ClaudeKeyPoolState {
  private readonly health = new Map<string, ClaudeKeyHealth>();

  /** sessionKey -> keyId, the prompt-cache affinity for Claude sessions. */
  private readonly sessionStickiness = new Map<string, { keyId: string; expiresAt: number }>();

  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: { now?: () => number; random?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /**
   * Pick the key for a request that the routing already resolved to `config`.
   * Returns the key to use. Profiles without a pool — and pools whose only
   * entry is the current single key — fall through untouched.
   */
  select(
    config: CompactGateConfig,
    profileId: string | null,
    headers: IncomingHttpHeaders
  ): ClaudeKeySelection | null {
    const entries = enabledApiKeyPool(config.claude.primary);
    if (entries.length <= 1) {
      return null;
    }

    const now = this.now();
    this.cleanupStickiness(now);
    const sessionKey = extractClaudeSessionKey(headers);
    if (sessionKey) {
      const pin = this.sessionStickiness.get(sessionKey);
      if (pin && pin.expiresAt > now) {
        const pinned = entries.find((entry) => entry.id === pin.keyId);
        if (pinned && !this.isBlocked(`${profileId}#${pinned.id}`, now)) {
          return { keyId: pinned.id, apiKey: pinned.api_key };
        }
      }
    }

    // The pinned key above is the only traffic a reserved key accepts, so this
    // has to come after that lookup and before the general pick.
    if (config.claude.primary.rotation_opt_out === true) {
      // Opted out of rotation: the first enabled key carries everything, and the
      // pool exists only as a manual fallback list. The UI has offered this
      // toggle for the Claude scope all along while only the codex side read it.
      const first = entries[0];
      const health = this.healthFor(`${profileId}#${first.id}`);
      health.inFlight += 1;
      health.lastSelectedAt = now;
      return { keyId: first.id, apiKey: first.api_key };
    }

    const spread = config.claude.primary.key_strategy === "spread";
    const candidates = entries.map((entry, index) => ({
      id: `${profileId}#${entry.id}`,
      entry,
      order: spread ? 0 : index
    }));

    // fill_first: the earliest eligible key wins; concurrent requests see the
    // same pin until its quarantine lands. spread: siblings share one slot and
    // the pick rolls across them so new sessions spread without any key's
    // quota being the single hot spot. A key inside its post-429 reserve window
    // is skipped here — it only serves the session already pinned to it above.
    const eligible = candidates
      .map((candidate) => ({ ...candidate, blockedUntil: this.blockedUntil(candidate.id, now) }))
      .filter((candidate) => candidate.blockedUntil <= now && !this.isStickyOnly(candidate.id, now))
      .sort((left, right) =>
        left.blockedUntil !== right.blockedUntil
          ? left.blockedUntil - right.blockedUntil
          : left.order - right.order
      );
    const pick = eligible.length > 0
      ? rollAmong(eligible, this.random)
      : // Nothing takes traffic: the soonest-to-unblock key, with jitter so
        // concurrent requests do not all wake on the same deadline.
        [...candidates]
          .sort((left, right) => {
            const leftUntil = this.blockedUntilWithJitter(left.id, now);
            const rightUntil = this.blockedUntilWithJitter(right.id, now);
            return leftUntil !== rightUntil
              ? leftUntil - rightUntil
              : left.order - right.order;
          })[0] ?? candidates[0];

    const health = this.healthFor(pick.id);
    health.inFlight += 1;
    health.lastSelectedAt = now;
    return { keyId: pick.entry.id, apiKey: pick.entry.api_key };
  }

  /**
   * A late in-flight must be released even if the request failed; the caller
   * records the outcome right after.
   */
  release(profileId: string | null, keyId: string | null): void {
    if (!profileId || !keyId) {
      return;
    }
    const health = this.health.get(`${profileId}#${keyId}`);
    if (health) {
      health.inFlight = Math.max(0, health.inFlight - 1);
    }
  }

  /**
   * `config` is the routed config the matching `select` ran against — it supplies
   * `sticky_reserve_seconds`. Optional so a caller that never configured a
   * reserve, and every existing test, keeps working unchanged.
   */
  recordResult(
    profileId: string | null,
    keyId: string | null,
    result: ClaudeKeyPoolResult,
    headers: IncomingHttpHeaders,
    config?: CompactGateConfig
  ): void {
    if (!profileId || !keyId) {
      return;
    }
    const composite = `${profileId}#${keyId}`;
    const health = this.healthFor(composite);
    health.inFlight = Math.max(0, health.inFlight - 1);
    const now = this.now();
    const status = result.status;

    if (status >= 200 && status < 300) {
      // A success is direct proof the key is whole again — it ends the
      // quarantine, clears the transient window and refreshes the session pin.
      health.transientFailures = 0;
      health.quarantineUntil = 0;
      health.rateLimitUntil = 0;
      health.cooldownUntil = 0;
      health.stickyOnlyUntil = 0;
      const sessionKey = extractClaudeSessionKey(headers);
      if (sessionKey) {
        this.rememberSessionPin(sessionKey, keyId, now);
      }
      return;
    }

    if (status === 401 || status === 403) {
      // Self-describing: the upstream says this credential is no good. Cool it
      // immediately — an 11-failure window would burn that many doomed
      // requests per dead key. Never disable permanently; recovery is a timer
      // or a success.
      health.quarantineUntil = Math.max(health.quarantineUntil, now + AUTH_QUARANTINE_MS);
      return;
    }

    if (status === 429) {
      health.rateLimitUntil = Math.max(
        health.rateLimitUntil,
        now + retryAfterCooldownMs(result.responseHeaders, now)
      );
      // Same reasoning as the codex route: when the cooldown expires the upstream
      // has only said "try me later", not "I am whole again", so the key stays
      // sticky-only for the configured reserve. A success ends the zone early.
      const reserveMs = (config?.claude.primary.sticky_reserve_seconds ?? 0) * 1000;
      if (reserveMs > 0) {
        health.stickyOnlyUntil = Math.max(health.stickyOnlyUntil, health.rateLimitUntil + reserveMs);
      }
      return;
    }

    if (status === 408 || status >= 500) {
      health.transientFailures += 1;
      if (health.transientFailures >= TRANSIENT_THRESHOLD) {
        const multiplier = Math.max(1, health.transientFailures - TRANSIENT_THRESHOLD + 1);
        health.cooldownUntil = Math.max(
          health.cooldownUntil,
          now + Math.min(TRANSIENT_COOLDOWN_MAX_MS, TRANSIENT_COOLDOWN_MS * multiplier)
        );
      }
      return;
    }

    // Everything else — request-shape 4xx, model-not-found 404, cancellations —
    // is the client's or the model's business, not the key's.
  }

  private blockedUntilWithJitter(composite: string, now: number): number {
    return this.blockedUntil(composite, now) + Math.round(this.random() * UNBLOCK_JITTER_MS);
  }

  /** Test seam: proves expired pins are evicted rather than accumulating. */
  stickinessSize(): number {
    return this.sessionStickiness.size;
  }

  blockState(profileId: string, keyId: string): number | null {
    const health = this.health.get(`${profileId}#${keyId}`);
    if (!health) {
      return null;
    }
    const until = Math.max(health.quarantineUntil, health.rateLimitUntil, health.cooldownUntil);
    return until > 0 ? until : null;
  }

  private healthFor(composite: string): ClaudeKeyHealth {
    const existing = this.health.get(composite);
    if (existing) {
      return existing;
    }
    const created: ClaudeKeyHealth = {
      inFlight: 0,
      transientFailures: 0,
      quarantineUntil: 0,
      rateLimitUntil: 0,
      cooldownUntil: 0,
      stickyOnlyUntil: 0,
      lastSelectedAt: 0
    };
    this.health.set(composite, created);
    return created;
  }

  private rememberSessionPin(sessionKey: string, keyId: string, now: number): void {
    // Bounded and re-inserted on touch, so the map evicts least-recently-used
    // rather than growing once per client session for the process's lifetime.
    rememberMapEntry(this.sessionStickiness, sessionKey, {
      keyId,
      expiresAt: now + SESSION_STICKY_TTL_MS
    });
    enforceMaxEntries(this.sessionStickiness, MAX_STICKY_ENTRIES);
  }

  private cleanupStickiness(now: number): void {
    for (const [sessionKey, pin] of this.sessionStickiness.entries()) {
      if (pin.expiresAt <= now) {
        this.sessionStickiness.delete(sessionKey);
      }
    }
  }

  private isBlocked(composite: string, now: number): boolean {
    return this.blockedUntil(composite, now) > now;
  }

  private isStickyOnly(composite: string, now: number): boolean {
    return (this.health.get(composite)?.stickyOnlyUntil ?? 0) > now;
  }

  private blockedUntil(composite: string, _now: number): number {
    const health = this.health.get(composite);
    if (!health) {
      return 0;
    }
    return Math.max(health.quarantineUntil, health.rateLimitUntil, health.cooldownUntil);
  }
}

function rollAmong<T extends { order: number }>(
  candidates: T[],
  random: () => number
): T {
  // fill_first: exactly one key is earliest, so the pick is deterministic —
  // concurrent traffic concentrates on it until a verdict lands (the same
  // behaviour as the codex side). spread: siblings share order 0, so roll.
  const minOrder = Math.min(...candidates.map((candidate) => candidate.order));
  const ties = candidates.filter((candidate) => candidate.order === minOrder);
  if (ties.length <= 1) {
    return ties[0];
  }
  return ties[Math.min(ties.length - 1, Math.floor(random() * ties.length))];
}

/**
 * Retry-After for Anthropic routes: an HTTP-date, a numeric seconds count, or
 * nothing (then the fixed fallback backoff). A ten minute cap keeps a hostile
 * or absurd header from exiling a key; the fallback keeps a 429 without a
 * reset time from being forgotten entirely.
 */
function retryAfterCooldownMs(headers: IncomingHttpHeaders, now: number): number {
  const value = readTrimmedString(Array.isArray(headers["retry-after"])
    ? headers["retry-after"][0]
    : headers["retry-after"]);
  if (value) {
    const seconds = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(RATE_LIMIT_MAX_MS, Math.round(seconds * 1000));
    }
    const timestamp = Date.parse(value);
    if (!Number.isNaN(timestamp) && timestamp > now) {
      return Math.min(RATE_LIMIT_MAX_MS, Math.max(0, timestamp - now));
    }
  }
  return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_FALLBACK_MS);
}

export function extractClaudeSessionKey(headers: IncomingHttpHeaders): string | null {
  return (
    readHeader(headers["x-claude-code-session-id"]) ??
    readHeader(headers["x-session-id"]) ??
    null
  );
}

function readHeader(value: IncomingHttpHeaders[string]): string | null {
  return readTrimmedString(Array.isArray(value) ? value[0] : value);
}