import type { IncomingHttpHeaders } from "node:http";
import type {
  CompactGateConfig,
  SavedConfigProfile,
  UpstreamConfig
} from "../shared/types.js";

const EMPTY_STREAM_FAILURE_THRESHOLD = 4;
const SESSION_STICKY_TTL_MS = 30 * 60 * 1000;
const CONTINUATION_STICKY_TTL_MS = 2 * 60 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 60 * 1000;
const TRANSIENT_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const ACCOUNT_QUARANTINE_MS = 30 * 60 * 1000;
const MODEL_DISABLE_MS = 12 * 60 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const RATE_LIMIT_MAX_MS = 10 * 60 * 1000;
const TOP_K_SCORE_WINDOW = 100;

export type PrimaryResultCategory =
  | "success"
  | "auth"
  | "quota"
  | "rate_limit"
  | "transient"
  | "model_incompatible"
  | "request_shape"
  | "client_cancel";

export interface PrimaryRouteRequestContext {
  endpoint?: string | null;
  model?: string | null;
  previousResponseId?: string | null;
  sessionKey?: string | null;
}

export interface PrimaryRouteSelection {
  config: CompactGateConfig;
  profileId: string | null;
  profileName: string | null;
  generation: number;
  healthVersion: number;
  context: Required<PrimaryRouteRequestContext>;
}

export interface PrimaryRouteResult {
  status: number;
  errorSummary: string | null;
  responseHeaders?: IncomingHttpHeaders;
  responseBody?: Buffer;
  firstTokenMs?: number | null;
  responseId?: string | null;
}

export interface PrimaryProfileHealthSnapshot {
  profileId: string;
  inFlight: number;
  transientFailures: number;
  emptyStreamFailures: number;
  cooldownUntil: number;
  quarantineUntil: number;
  rateLimitUntil: number;
  modelCooldowns: Array<{ model: string; until: number; reason: string }>;
}

interface PrimaryCandidate {
  id: string;
  name: string;
  config: CompactGateConfig;
  order: number;
  active: boolean;
}

interface ProfileHealth {
  version: number;
  inFlight: number;
  successes: number;
  failures: number;
  transientFailures: number;
  emptyStreamFailures: number;
  rateLimitFailures: number;
  cooldownUntil: number;
  quarantineUntil: number;
  rateLimitUntil: number;
  lastFirstTokenMs: number | null;
  lastSelectedAt: number;
  modelCooldowns: Map<string, ModelCooldown>;
}

interface ModelCooldown {
  until: number;
  reason: string;
}

interface StickyEntry {
  profileId: string;
  expiresAt: number;
}

interface ScoredCandidate {
  candidate: PrimaryCandidate;
  score: number;
}

interface PrimaryFailoverOptions {
  now?: () => number;
  random?: () => number;
}

export class PrimaryFailoverState {
  private signature = "";
  private generation = 0;
  private readonly health = new Map<string, ProfileHealth>();
  private readonly sessionStickiness = new Map<string, StickyEntry>();
  private readonly continuationStickiness = new Map<string, StickyEntry>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: PrimaryFailoverOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  select(
    config: CompactGateConfig,
    context: PrimaryRouteRequestContext = {}
  ): PrimaryRouteSelection {
    return this.selectInternal(config, context, true);
  }

  preview(
    config: CompactGateConfig,
    context: PrimaryRouteRequestContext = {}
  ): PrimaryRouteSelection {
    return this.selectInternal(config, context, false);
  }

  recordResult(
    selection: PrimaryRouteSelection,
    resultOrStatus: PrimaryRouteResult | number,
    maybeErrorSummary?: string | null
  ): void {
    if (!selection.profileId) {
      return;
    }

    const result = normalizeResult(resultOrStatus, maybeErrorSummary);
    const health = this.health.get(selection.profileId);
    if (!health) {
      return;
    }

    health.inFlight = Math.max(0, health.inFlight - 1);
    if (selection.generation !== this.generation) {
      return;
    }

    const now = this.now();
    const category = classifyPrimaryRouteResult(result);
    const staleSuccess = category === "success" && selection.healthVersion !== health.version;
    const countsAsProfileFailure =
      category !== "success" && category !== "request_shape" && category !== "client_cancel";
    if (countsAsProfileFailure) {
      health.failures += 1;
    }

    switch (category) {
      case "success":
        health.successes += 1;
        health.lastFirstTokenMs = result.firstTokenMs ?? health.lastFirstTokenMs;
        if (!staleSuccess) {
          health.transientFailures = 0;
          health.emptyStreamFailures = 0;
          health.rateLimitFailures = 0;
          health.cooldownUntil = 0;
          health.rateLimitUntil = 0;
          health.version += 1;
        }
        this.rememberResponseStickiness(selection, result, now);
        break;
      case "auth":
      case "quota":
        health.transientFailures = 0;
        health.emptyStreamFailures = 0;
        health.quarantineUntil = Math.max(health.quarantineUntil, now + ACCOUNT_QUARANTINE_MS);
        health.version += 1;
        break;
      case "rate_limit": {
        health.rateLimitFailures += 1;
        health.rateLimitUntil = Math.max(
          health.rateLimitUntil,
          now + rateLimitCooldownMs(result, health.rateLimitFailures, now)
        );
        health.version += 1;
        break;
      }
      case "transient": {
        health.transientFailures += 1;
        if (isReconnectLikePrimaryFailure(result.status, result.errorSummary)) {
          health.emptyStreamFailures += 1;
        }
        const shouldCooldown =
          !isReconnectLikePrimaryFailure(result.status, result.errorSummary) ||
          health.emptyStreamFailures >= EMPTY_STREAM_FAILURE_THRESHOLD;
        if (shouldCooldown) {
          const multiplier = Math.max(1, health.transientFailures - EMPTY_STREAM_FAILURE_THRESHOLD + 1);
          health.cooldownUntil = Math.max(
            health.cooldownUntil,
            now + Math.min(TRANSIENT_COOLDOWN_MAX_MS, TRANSIENT_COOLDOWN_MS * multiplier)
          );
        }
        health.version += 1;
        break;
      }
      case "model_incompatible": {
        const model = selection.context.model;
        if (model) {
          health.modelCooldowns.set(model, {
            until: now + MODEL_DISABLE_MS,
            reason: result.errorSummary ?? `HTTP ${result.status}`
          });
        } else {
          health.cooldownUntil = Math.max(health.cooldownUntil, now + TRANSIENT_COOLDOWN_MS);
        }
        health.version += 1;
        break;
      }
      case "request_shape":
      case "client_cancel":
        break;
    }
  }

  getHealthSnapshot(): PrimaryProfileHealthSnapshot[] {
    return [...this.health.entries()].map(([profileId, health]) => ({
      profileId,
      inFlight: health.inFlight,
      transientFailures: health.transientFailures,
      emptyStreamFailures: health.emptyStreamFailures,
      cooldownUntil: health.cooldownUntil,
      quarantineUntil: health.quarantineUntil,
      rateLimitUntil: health.rateLimitUntil,
      modelCooldowns: [...health.modelCooldowns.entries()].map(([model, cooldown]) => ({
        model,
        until: cooldown.until,
        reason: cooldown.reason
      }))
    }));
  }

  private selectInternal(
    config: CompactGateConfig,
    context: PrimaryRouteRequestContext,
    reserve: boolean
  ): PrimaryRouteSelection {
    const candidates = codexPrimaryCandidates(config);
    const normalizedContext = normalizeRequestContext(context);
    if (candidates.length === 0) {
      return {
        config,
        profileId: null,
        profileName: null,
        generation: this.generation,
        healthVersion: 0,
        context: normalizedContext
      };
    }

    const signature = candidateSignature(config, candidates);
    if (signature !== this.signature) {
      this.signature = signature;
      this.generation += 1;
      this.health.clear();
      this.sessionStickiness.clear();
      this.continuationStickiness.clear();
    }

    this.reconcileHealth(candidates);
    const now = this.now();
    this.cleanupExpiredState(now);

    const selected =
      this.selectStickyCandidate(candidates, normalizedContext, now) ??
      this.selectScoredCandidate(candidates, normalizedContext, now);
    const health = this.healthFor(selected.id);
    if (reserve) {
      health.inFlight += 1;
      health.lastSelectedAt = now;
      this.rememberRequestStickiness(normalizedContext, selected.id, now);
    }

    return {
      config: selected.config,
      profileId: selected.id,
      profileName: selected.name,
      generation: this.generation,
      healthVersion: health.version,
      context: normalizedContext
    };
  }

  private reconcileHealth(candidates: PrimaryCandidate[]): void {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    for (const id of [...this.health.keys()]) {
      if (!candidateIds.has(id)) {
        this.health.delete(id);
      }
    }
    for (const candidate of candidates) {
      this.healthFor(candidate.id);
    }
  }

  private selectStickyCandidate(
    candidates: PrimaryCandidate[],
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): PrimaryCandidate | null {
    if (context.previousResponseId) {
      const sticky = this.continuationStickiness.get(context.previousResponseId);
      const candidate = sticky
        ? this.usableCandidateById(candidates, sticky.profileId, context, now)
        : null;
      if (candidate) {
        return candidate;
      }
    }

    if (context.sessionKey) {
      const sticky = this.sessionStickiness.get(context.sessionKey);
      const candidate = sticky
        ? this.usableCandidateById(candidates, sticky.profileId, context, now)
        : null;
      if (candidate) {
        return candidate;
      }
    }

    return null;
  }

  private selectScoredCandidate(
    candidates: PrimaryCandidate[],
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): PrimaryCandidate {
    const eligible = candidates.filter((candidate) => this.isCandidateEligible(candidate, context, now));
    const pool = eligible.length > 0
      ? eligible
      : [...candidates].sort((left, right) => {
          const leftUntil = this.blockedUntil(left, context, now);
          const rightUntil = this.blockedUntil(right, context, now);
          return leftUntil === rightUntil ? left.order - right.order : leftUntil - rightUntil;
        });
    const scored = pool
      .map((candidate) => ({
        candidate,
        score: this.scoreCandidate(candidate, context, now)
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.candidate.order - right.candidate.order;
      });
    const best = scored[0];
    if (!best) {
      return candidates[0];
    }

    const topK = scored
      .filter((candidate) => best.score - candidate.score <= TOP_K_SCORE_WINDOW)
      .slice(0, 3);
    if (topK.length <= 1) {
      return best.candidate;
    }

    return this.weightedChoice(topK);
  }

  private scoreCandidate(
    candidate: PrimaryCandidate,
    _context: Required<PrimaryRouteRequestContext>,
    _now: number
  ): number {
    const health = this.healthFor(candidate.id);
    const total = health.successes + health.failures;
    const errorRate = total > 0 ? health.failures / total : 0;
    const latencyPenalty = health.lastFirstTokenMs === null
      ? 0
      : Math.min(200, Math.round(health.lastFirstTokenMs / 100));

    return (
      10_000 -
      candidate.order * 500 -
      health.inFlight * 80 -
      health.transientFailures * 40 -
      Math.round(errorRate * 250) -
      latencyPenalty +
      (candidate.active ? 1_000 : 0)
    );
  }

  private weightedChoice(candidates: ScoredCandidate[]): PrimaryCandidate {
    const minScore = Math.min(...candidates.map((candidate) => candidate.score));
    const weights = candidates.map((candidate) => Math.max(1, candidate.score - minScore + 1));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let roll = this.random() * total;
    for (let index = 0; index < candidates.length; index += 1) {
      roll -= weights[index];
      if (roll <= 0) {
        return candidates[index].candidate;
      }
    }

    return candidates[0].candidate;
  }

  private usableCandidateById(
    candidates: PrimaryCandidate[],
    profileId: string,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): PrimaryCandidate | null {
    const candidate = candidates.find((item) => item.id === profileId);
    if (!candidate || !this.isCandidateEligible(candidate, context, now)) {
      return null;
    }

    return candidate;
  }

  private isCandidateEligible(
    candidate: PrimaryCandidate,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): boolean {
    return this.blockedUntil(candidate, context, now) <= now;
  }

  private blockedUntil(
    candidate: PrimaryCandidate,
    context: Required<PrimaryRouteRequestContext>,
    now: number
  ): number {
    const health = this.healthFor(candidate.id);
    const model = context.model;
    const modelCooldown = model ? health.modelCooldowns.get(model)?.until ?? 0 : 0;
    if (model && modelCooldown > 0 && modelCooldown <= now) {
      health.modelCooldowns.delete(model);
    }

    return Math.max(
      health.cooldownUntil,
      health.quarantineUntil,
      health.rateLimitUntil,
      modelCooldown
    );
  }

  private rememberRequestStickiness(
    context: Required<PrimaryRouteRequestContext>,
    profileId: string,
    now: number
  ): void {
    if (context.sessionKey) {
      this.sessionStickiness.set(context.sessionKey, {
        profileId,
        expiresAt: now + SESSION_STICKY_TTL_MS
      });
    }
    if (context.previousResponseId) {
      this.continuationStickiness.set(context.previousResponseId, {
        profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
    }
  }

  private rememberResponseStickiness(
    selection: PrimaryRouteSelection,
    result: PrimaryRouteResult,
    now: number
  ): void {
    if (!selection.profileId) {
      return;
    }

    const responseId = readResponseId(result);
    if (responseId) {
      this.continuationStickiness.set(responseId, {
        profileId: selection.profileId,
        expiresAt: now + CONTINUATION_STICKY_TTL_MS
      });
    }
    if (selection.context.sessionKey) {
      this.sessionStickiness.set(selection.context.sessionKey, {
        profileId: selection.profileId,
        expiresAt: now + SESSION_STICKY_TTL_MS
      });
    }
  }

  private cleanupExpiredState(now: number): void {
    cleanupStickyMap(this.sessionStickiness, now);
    cleanupStickyMap(this.continuationStickiness, now);
    for (const health of this.health.values()) {
      for (const [model, cooldown] of health.modelCooldowns.entries()) {
        if (cooldown.until <= now) {
          health.modelCooldowns.delete(model);
        }
      }
    }
  }

  private healthFor(profileId: string): ProfileHealth {
    const existing = this.health.get(profileId);
    if (existing) {
      return existing;
    }

    const created: ProfileHealth = {
      version: 0,
      inFlight: 0,
      successes: 0,
      failures: 0,
      transientFailures: 0,
      emptyStreamFailures: 0,
      rateLimitFailures: 0,
      cooldownUntil: 0,
      quarantineUntil: 0,
      rateLimitUntil: 0,
      lastFirstTokenMs: null,
      lastSelectedAt: 0,
      modelCooldowns: new Map()
    };
    this.health.set(profileId, created);
    return created;
  }
}

export function classifyPrimaryRouteResult(result: PrimaryRouteResult): PrimaryResultCategory {
  const summary = result.errorSummary?.toLowerCase() ?? "";

  if (isClientCancelSummary(summary)) {
    return "client_cancel";
  }

  if (result.status >= 200 && result.status < 300 && !result.errorSummary) {
    return "success";
  }

  if (isModelIncompatibleFailure(result.status, summary)) {
    return "model_incompatible";
  }

  if (result.status === 400 || result.status === 422) {
    return "request_shape";
  }

  if (result.status === 429) {
    return "rate_limit";
  }

  if (result.status === 401 || isAuthFailureSummary(summary)) {
    return "auth";
  }

  if (result.status === 402 || result.status === 403 || isQuotaFailureSummary(summary)) {
    return "quota";
  }

  if (
    result.status === 408 ||
    result.status >= 500 ||
    isReconnectLikePrimaryFailure(result.status, result.errorSummary)
  ) {
    return "transient";
  }

  return result.status >= 400 || result.errorSummary ? "transient" : "success";
}

export function isReconnectLikePrimaryFailure(status: number, errorSummary: string | null): boolean {
  if (!errorSummary) {
    return false;
  }

  const lower = errorSummary.toLowerCase();
  if (
    status >= 200 &&
    status < 300 &&
    (
      lower.includes("openai stream closed before response.completed") ||
      lower.includes("stream closed before response.completed") ||
      lower.includes("not text/event-stream") ||
      lower.includes("without response.completed") ||
      lower.includes("without a terminal event or output token")
    )
  ) {
    return true;
  }

  if (status < 500) {
    return false;
  }

  return [
    "reconnect",
    "response aborted",
    "socket hang up",
    "econnreset",
    "network socket disconnected",
    "stream disconnected before valid content",
    "stream closed before response.completed",
    "upstream_stream_error",
    "received 0 chars"
  ].some((pattern) => lower.includes(pattern));
}

export function primaryRouteRequestContextFromBody(
  rawBody: Buffer,
  headers: IncomingHttpHeaders = {},
  endpoint: string | null = null
): PrimaryRouteRequestContext {
  const parsed = parseJsonRecord(rawBody);
  const model = readTrimmedString(parsed?.model);
  const previousResponseId =
    readTrimmedString(parsed?.previous_response_id) ??
    readTrimmedString(parsed?.previousResponseId);

  return {
    endpoint,
    model,
    previousResponseId,
    sessionKey: readSessionKey(parsed, headers)
  };
}

function normalizeResult(
  resultOrStatus: PrimaryRouteResult | number,
  maybeErrorSummary?: string | null
): PrimaryRouteResult {
  if (typeof resultOrStatus === "number") {
    return {
      status: resultOrStatus,
      errorSummary: maybeErrorSummary ?? null
    };
  }

  return resultOrStatus;
}

function normalizeRequestContext(
  context: PrimaryRouteRequestContext
): Required<PrimaryRouteRequestContext> {
  return {
    endpoint: context.endpoint ?? null,
    model: context.model ?? null,
    previousResponseId: context.previousResponseId ?? null,
    sessionKey: context.sessionKey ?? null
  };
}

function codexPrimaryCandidates(config: CompactGateConfig): PrimaryCandidate[] {
  const state = config.profile_scopes?.codex;
  const profiles = state?.profiles ?? [];
  if (profiles.length === 0 || !state?.active_profile_id) {
    return [];
  }

  const candidates = profiles.filter((profile) => Boolean(readProfilePrimary(profile)));
  const activeIndex = candidates.findIndex((profile) => profile.id === state.active_profile_id);

  return candidates.map((profile, index) => ({
    id: profile.id,
    name: profile.name,
    order: activeIndex >= 0
      ? (index - activeIndex + candidates.length) % candidates.length
      : index,
    active: profile.id === state.active_profile_id,
    config: configWithProfilePrimary(config, profile)
  }));
}

function configWithProfilePrimary(config: CompactGateConfig, profile: SavedConfigProfile): CompactGateConfig {
  return {
    ...cloneConfig(config),
    primary: {
      ...config.primary,
      ...readProfilePrimary(profile)
    }
  };
}

function readProfilePrimary(profile: SavedConfigProfile): Partial<UpstreamConfig> | null {
  const config = profile.config;
  if (!isRecord(config) || !isRecord(config.primary)) {
    return null;
  }

  return config.primary as Partial<UpstreamConfig>;
}

function candidateSignature(config: CompactGateConfig, candidates: PrimaryCandidate[]): string {
  const activeProfileId = config.profile_scopes?.codex?.active_profile_id ?? "";
  const candidateParts = candidates.map((candidate) => [
    candidate.id,
    candidate.config.primary.base_url,
    candidate.config.primary.api_key_env,
    candidate.config.primary.api_key.length > 0 ? "key" : "no-key"
  ].join("|"));
  return [activeProfileId, ...candidateParts].join("::");
}

function rateLimitCooldownMs(result: PrimaryRouteResult, failureCount: number, now: number): number {
  const retryAfterMs = parseRetryAfterMs(result.responseHeaders, now);
  if (retryAfterMs !== null) {
    return Math.min(RATE_LIMIT_MAX_MS, retryAfterMs);
  }

  return Math.min(RATE_LIMIT_MAX_MS, RATE_LIMIT_FALLBACK_MS * 2 ** Math.max(0, failureCount - 1));
}

function parseRetryAfterMs(headers: IncomingHttpHeaders | undefined, now: number): number | null {
  const value = readHeader(headers?.["retry-after"]);
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const timestamp = Date.parse(value);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - now);
  }

  return null;
}

function readResponseId(result: PrimaryRouteResult): string | null {
  const explicit = readTrimmedString(result.responseId);
  if (explicit) {
    return explicit;
  }

  const body = result.responseBody;
  if (!body || body.byteLength === 0) {
    return null;
  }

  const text = body.toString("utf8");
  const contentType = readHeader(result.responseHeaders?.["content-type"])?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    return readSseResponseId(text);
  }

  return readJsonResponseId(text);
}

function readSseResponseId(text: string): string | null {
  const frames = text.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }

    const responseId = readJsonResponseId(data);
    if (responseId) {
      return responseId;
    }
  }

  return null;
}

function readJsonResponseId(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return readTrimmedString(parsed.id) ??
      (isRecord(parsed.response) ? readTrimmedString(parsed.response.id) : null);
  } catch {
    return null;
  }
}

function readSessionKey(
  parsed: Record<string, unknown> | null,
  headers: IncomingHttpHeaders
): string | null {
  const metadata = isRecord(parsed?.metadata) ? parsed.metadata : null;
  return (
    readTrimmedString(parsed?.session_hash) ??
    readTrimmedString(parsed?.session_id) ??
    readTrimmedString(parsed?.conversation_id) ??
    readTrimmedString(metadata?.session_hash) ??
    readTrimmedString(metadata?.session_id) ??
    readHeader(headers["x-compactgate-session"]) ??
    readHeader(headers["x-session-id"]) ??
    readHeader(headers["x-conversation-id"]) ??
    readHeader(headers["openai-conversation-id"])
  );
}

function isClientCancelSummary(summary: string): boolean {
  return (
    summary.includes("client disconnected before upstream response completed") ||
    summary.includes("client canceled") ||
    summary.includes("client cancelled")
  );
}

function isAuthFailureSummary(summary: string): boolean {
  return [
    "invalid api key",
    "invalid token",
    "unauthorized",
    "authentication",
    "auth token",
    "api key is invalid"
  ].some((pattern) => summary.includes(pattern));
}

function isQuotaFailureSummary(summary: string): boolean {
  return [
    "insufficient balance",
    "insufficient_quota",
    "quota exceeded",
    "credit balance",
    "billing",
    "account balance"
  ].some((pattern) => summary.includes(pattern));
}

function isModelIncompatibleFailure(status: number, summary: string): boolean {
  if (status !== 404 && status !== 400) {
    return false;
  }

  return (
    summary.includes("model") &&
    (
      summary.includes("not found") ||
      summary.includes("does not exist") ||
      summary.includes("unavailable") ||
      summary.includes("unsupported")
    )
  );
}

function cleanupStickyMap(map: Map<string, StickyEntry>, now: number): void {
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAt <= now) {
      map.delete(key);
    }
  }
}

function parseJsonRecord(rawBody: Buffer): Record<string, unknown> | null {
  if (rawBody.byteLength === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readHeader(value: IncomingHttpHeaders[string]): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return readTrimmedString(raw);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function cloneConfig(config: CompactGateConfig): CompactGateConfig {
  return JSON.parse(JSON.stringify(config)) as CompactGateConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
