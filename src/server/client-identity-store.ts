import fs from "node:fs/promises";
import path from "node:path";
import type {
  ClientIdentityKind,
  ClientIdentityKindState,
  ClientIdentityKindStatus,
  ClientIdentityResolved,
  ClientIdentitySourceKind,
  ClientIdentityState,
  ClientIdentityStatus,
  ClientIdentityUaState
} from "../shared/types.js";
import {
  CLIENT_IDENTITY_REGISTRY_PACKAGES,
  factoryClientUserAgent
} from "./config-defaults.js";
import { stripUserAgentVariants, swapUserAgentVersion } from "./client-identity.js";
import { isRecord, readTrimmedString } from "./http-utils.js";
import { requestJson } from "./upstream-json-client.js";

const CLIENT_IDENTITY_KINDS: ClientIdentityKind[] = ["codex", "claude"];

/**
 * A registry version older than this is no longer trusted. Without a ceiling an
 * offline machine would pin the version-tracked UA to whatever it last fetched —
 * possibly months stale — and keep preferring it over the real client sitting
 * right in front of it. Past the TTL the version is dropped and the stored UA
 * serves its own version again.
 */
const REMOTE_VERSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** One refresh per calendar day once it succeeds; this is the retry gap until then. */
const RETRY_INTERVAL_MS = 60 * 60 * 1000;
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 5_000;
const MAX_REGISTRY_RESPONSE_BYTES = 512 * 1024;
/**
 * Long enough for the full-form Codex UA (~95 chars) plus a generous margin, short
 * enough that a hand-edited value cannot smuggle a multi-kilobyte header upstream.
 */
const MAX_USER_AGENT_LENGTH = 512;

export interface ClientIdentityStoreOptions {
  statePath: string;
  now?: () => Date;
  fetchLatestVersion?: (kind: ClientIdentityKind) => Promise<string | null>;
  tickIntervalMs?: number;
}

export interface ClientIdentityPatch {
  enabled?: boolean;
  codex?: ClientIdentityKindPatch;
  claude?: ClientIdentityKindPatch;
}

export interface ClientIdentityKindPatch {
  preferred?: ClientIdentitySourceKind;
  /** A string sets a manual value; `null` clears `manual` and resumes automatic updates. */
  extracted_user_agent?: string | null;
  version_tracked_user_agent?: string | null;
}

export class ClientIdentityStore {
  private readonly statePath: string;

  private readonly now: () => Date;

  private readonly fetchLatestVersion: (kind: ClientIdentityKind) => Promise<string | null>;

  private readonly tickIntervalMs: number;

  private state: ClientIdentityState = factoryState();

  private timer: ReturnType<typeof setInterval> | null = null;

  private writing: Promise<void> = Promise.resolve();

  private refreshing = false;

  private loaded = false;

  private closed = false;

  constructor(options: ClientIdentityStoreOptions) {
    this.statePath = options.statePath;
    this.now = options.now ?? (() => new Date());
    this.fetchLatestVersion = options.fetchLatestVersion ?? fetchLatestRegistryVersion;
    this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
  }

  /**
   * Reads persisted state, runs whatever refresh is owed, then starts the loop.
   * The loop ticks far more often than it acts: `refreshDue` decides per source
   * whether anything is owed, so a long-running process refreshes shortly after
   * midnight instead of 24 hours after it happened to start.
   *
   * Callers must not await this on a hot path — it makes a network request.
   * Rewriting serves the persisted or factory agent until it resolves.
   */
  async start(): Promise<void> {
    await this.load();
    if (this.closed) {
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.refreshDue(), this.tickIntervalMs);
      this.timer.unref?.();
    }

    await this.refreshDue();
  }

  /**
   * Stops the refresh loop and blocks every further write. Without the write block
   * a refresh already in flight would re-create the state file after shutdown —
   * which, when the file lives in a directory being torn down, races the removal.
   */
  close(): void {
    this.closed = true;
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  /** Awaits any in-flight write so a test or shutdown sees a settled file. */
  async flush(): Promise<void> {
    await this.writing;
  }

  /**
   * The UA to send for this family, or null when rewriting is off or nothing is
   * available. `null` means "leave the client's own header alone".
   */
  userAgentFor(kind: ClientIdentityKind): string | null {
    if (!this.state.enabled) {
      return null;
    }

    return this.resolve(kind).user_agent;
  }

  /**
   * Records a real CLI request's UA as the extracted source. Called on the proxy
   * hot path, so it does nothing at all unless today's extraction is still owed —
   * the common case is a comparison against a date string.
   */
  observeCliUserAgent(kind: ClientIdentityKind, userAgent: string | null): void {
    const trimmed = readTrimmedString(userAgent);
    if (!trimmed || trimmed.length > MAX_USER_AGENT_LENGTH) {
      return;
    }

    const source = this.state[kind].extracted;
    if (source.manual || source.last_success_date === this.today()) {
      return;
    }

    const normalized = stripUserAgentVariants(trimmed);
    const at = this.now().toISOString();
    this.state = withSource(this.state, kind, "extracted", {
      user_agent: normalized,
      manual: false,
      updated_at: at,
      last_success_date: this.today(),
      last_attempt_at: at,
      last_error: null
    });
    this.persist();
  }

  status(): ClientIdentityStatus {
    return {
      ...this.state,
      codex: this.kindStatus("codex"),
      claude: this.kindStatus("claude"),
      resolved: {
        codex: this.resolve("codex"),
        claude: this.resolve("claude")
      }
    };
  }

  private kindStatus(kind: ClientIdentityKind): ClientIdentityKindStatus {
    const state = this.state[kind];
    const remoteStale = this.isRemoteVersionStale(state);
    return {
      ...state,
      extracted: {
        ...state.extracted,
        outbound_user_agent: this.userAgentForSource(kind, "extracted", remoteStale) ?? ""
      },
      version_tracked: {
        ...state.version_tracked,
        outbound_user_agent: this.userAgentForSource(kind, "version_tracked", remoteStale) ?? ""
      }
    };
  }

  /**
   * Applies operator intent. A supplied UA string marks that source manual, which
   * stops automatic updates for it — a value the operator typed being silently
   * overwritten by a background refresh is the one behaviour that would make this
   * panel untrustworthy. Passing null reverts to automatic.
   */
  async update(patch: ClientIdentityPatch): Promise<ClientIdentityStatus> {
    let next = this.state;
    if (typeof patch.enabled === "boolean") {
      next = { ...next, enabled: patch.enabled };
    }

    for (const kind of CLIENT_IDENTITY_KINDS) {
      const kindPatch = patch[kind];
      if (!kindPatch) {
        continue;
      }

      if (kindPatch.preferred) {
        next = { ...next, [kind]: { ...next[kind], preferred: kindPatch.preferred } };
      }
      next = applyManualPatch(next, kind, "extracted", kindPatch.extracted_user_agent, this.now());
      next = applyManualPatch(
        next,
        kind,
        "version_tracked",
        kindPatch.version_tracked_user_agent,
        this.now()
      );
    }

    this.state = next;
    this.persist();
    await this.flush();
    return this.status();
  }

  /** Operator-triggered refresh; bypasses the once-a-day gate. */
  async refreshNow(kind?: ClientIdentityKind): Promise<ClientIdentityStatus> {
    const kinds = kind ? [kind] : CLIENT_IDENTITY_KINDS;
    for (const target of kinds) {
      await this.refreshVersionTracked(target, true);
    }
    await this.flush();
    return this.status();
  }

  private resolve(kind: ClientIdentityKind): ClientIdentityResolved {
    const state = this.state[kind];
    const preferred = state.preferred;
    const fallback: ClientIdentitySourceKind = preferred === "extracted"
      ? "version_tracked"
      : "extracted";
    const remoteStale = this.isRemoteVersionStale(state);

    for (const source of [preferred, fallback]) {
      const userAgent = this.userAgentForSource(kind, source, remoteStale);
      if (userAgent) {
        return {
          user_agent: userAgent,
          source,
          fell_back: source !== preferred,
          remote_version_stale: remoteStale
        };
      }
    }

    // Both sources declined. The only way to get here is an expired registry
    // version with nothing observed, and sending no identity at all would be
    // worse than sending the stored agent with its own version — a stale version
    // still passes a product-token gate.
    const stored = readTrimmedString(state.version_tracked.user_agent);
    return {
      user_agent: stored,
      source: stored ? "version_tracked" : null,
      fell_back: stored !== null && preferred !== "version_tracked",
      remote_version_stale: remoteStale
    };
  }

  /**
   * The version-tracked source stores a UA and, separately, the version the
   * registry reported. The version is applied at read time rather than baked in,
   * so an expired TTL simply stops being applied instead of needing the stored UA
   * to be rewritten back — and the source steps aside so a real observation, which
   * is current by definition, gets to serve instead.
   */
  private userAgentForSource(
    kind: ClientIdentityKind,
    source: ClientIdentitySourceKind,
    remoteStale: boolean
  ): string | null {
    const state = this.state[kind];
    const stored = readTrimmedString(state[source].user_agent);
    if (!stored) {
      return null;
    }
    if (source === "extracted" || state[source].manual) {
      return stored;
    }
    if (remoteStale) {
      return null;
    }

    const version = readTrimmedString(state.remote_version);
    return version ? swapUserAgentVersion(stored, version) : stored;
  }

  private isRemoteVersionStale(state: ClientIdentityKindState): boolean {
    if (!state.remote_version) {
      return false;
    }
    const fetchedAt = state.remote_version_at ? Date.parse(state.remote_version_at) : Number.NaN;
    if (!Number.isFinite(fetchedAt)) {
      return true;
    }
    return this.now().getTime() - fetchedAt > REMOTE_VERSION_TTL_MS;
  }

  /**
   * Runs whatever refresh is owed right now. Public so the caller — and a test —
   * can drive the schedule explicitly instead of waiting on the timer.
   */
  async refreshDue(): Promise<void> {
    if (this.refreshing || this.closed) {
      return;
    }

    this.refreshing = true;
    try {
      for (const kind of CLIENT_IDENTITY_KINDS) {
        await this.refreshVersionTracked(kind, false);
      }
      await this.flush();
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshVersionTracked(kind: ClientIdentityKind, force: boolean): Promise<void> {
    const source = this.state[kind].version_tracked;
    if (source.manual || (!force && !this.isRefreshDue(source))) {
      return;
    }

    const attemptedAt = this.now().toISOString();
    let version: string | null = null;
    let error: string | null = null;
    try {
      version = await this.fetchLatestVersion(kind);
      if (!version) {
        error = "Registry response carried no version.";
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Registry request failed.";
    }

    if (!version) {
      this.state = withSource(this.state, kind, "version_tracked", {
        ...this.state[kind].version_tracked,
        last_attempt_at: attemptedAt,
        last_error: error
      });
      this.persist();
      return;
    }

    this.state = {
      ...this.state,
      [kind]: {
        ...this.state[kind],
        remote_version: version,
        remote_version_at: attemptedAt,
        version_tracked: {
          ...this.state[kind].version_tracked,
          updated_at: attemptedAt,
          last_success_date: this.today(),
          last_attempt_at: attemptedAt,
          last_error: null
        }
      }
    };
    this.persist();
  }

  /**
   * Due when today has had no success yet and the last attempt is at least an hour
   * old. The success gate is a date rather than a countdown so it resets at
   * midnight and survives a restart.
   */
  private isRefreshDue(source: ClientIdentityUaState): boolean {
    if (source.last_success_date === this.today()) {
      return false;
    }
    const lastAttempt = source.last_attempt_at ? Date.parse(source.last_attempt_at) : Number.NaN;
    if (!Number.isFinite(lastAttempt)) {
      return true;
    }
    return this.now().getTime() - lastAttempt >= RETRY_INTERVAL_MS;
  }

  private today(): string {
    const at = this.now();
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      // Re-reading would discard in-memory updates that have not been flushed yet,
      // so the file is authoritative exactly once.
      return;
    }

    this.loaded = true;
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      this.state = normalizeState(JSON.parse(raw) as unknown);
    } catch {
      // A missing or unreadable file is the first-run case: keep the factory
      // state rather than failing startup over an optional cache.
      this.state = factoryState();
    }
  }

  /**
   * Serializes writes through a promise chain so two rapid updates cannot
   * interleave their temp-file rename. Failures are swallowed on purpose: this is
   * a cache beside the log database, and losing it costs one re-fetch.
   */
  private persist(): void {
    if (this.closed) {
      return;
    }

    const snapshot = this.state;
    this.writing = this.writing
      .then(() => writeJsonAtomically(this.statePath, snapshot))
      .catch(() => undefined);
  }
}

export function resolveClientIdentityStatePath(configPath: string): string {
  const base = path.basename(configPath, path.extname(configPath));
  return path.resolve(path.dirname(configPath), `${base}-client-identity.json`);
}

/**
 * The npm registry is the only source that answers with a version at all: the
 * published packages carry no User-Agent, and neither CLI's `--version` nor its
 * binary exposes the assembled UA string. Verified against both packages.
 */
async function fetchLatestRegistryVersion(kind: ClientIdentityKind): Promise<string | null> {
  const packageName = CLIENT_IDENTITY_REGISTRY_PACKAGES[kind];
  const upstream = new URL(
    `https://registry.npmjs.org/${packageName}/latest`
  );
  const body = await requestJson(
    upstream,
    { accept: "application/json", "accept-encoding": "identity" },
    REGISTRY_TIMEOUT_MS,
    { maxResponseBytes: MAX_REGISTRY_RESPONSE_BYTES }
  );
  const version = isRecord(body) ? readTrimmedString(body.version) : null;
  return version && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

async function writeJsonAtomically(filePath: string, state: ClientIdentityState): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const handle = await fs.open(temporaryPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
}

function applyManualPatch(
  state: ClientIdentityState,
  kind: ClientIdentityKind,
  source: ClientIdentitySourceKind,
  value: string | null | undefined,
  at: Date
): ClientIdentityState {
  if (value === undefined) {
    return state;
  }

  if (value === null) {
    return withSource(state, kind, source, {
      ...state[kind][source],
      manual: false
    });
  }

  const userAgent = readTrimmedString(value) ?? "";
  if (userAgent.length > MAX_USER_AGENT_LENGTH) {
    throw new ClientIdentityValueError(
      `user-agent must be at most ${MAX_USER_AGENT_LENGTH} characters.`
    );
  }
  if (!isValidHeaderValue(userAgent)) {
    throw new ClientIdentityValueError("user-agent must not contain control characters.");
  }

  return withSource(state, kind, source, {
    user_agent: userAgent,
    manual: true,
    updated_at: at.toISOString(),
    last_success_date: state[kind][source].last_success_date,
    last_attempt_at: state[kind][source].last_attempt_at,
    last_error: null
  });
}

export class ClientIdentityValueError extends Error {}

/**
 * A newline or NUL in a header value is header injection, and the value reaches
 * here straight from an operator-facing text input.
 */
function isValidHeaderValue(value: string): boolean {
  return value.length === 0 || !/[\u0000-\u001f]/.test(value);
}

function withSource(
  state: ClientIdentityState,
  kind: ClientIdentityKind,
  source: ClientIdentitySourceKind,
  next: ClientIdentityUaState
): ClientIdentityState {
  return {
    ...state,
    [kind]: {
      ...state[kind],
      [source]: next
    }
  };
}

function factoryState(): ClientIdentityState {
  return {
    enabled: true,
    codex: factoryKindState("codex"),
    claude: factoryKindState("claude")
  };
}

function factoryKindState(kind: ClientIdentityKind): ClientIdentityKindState {
  return {
    extracted: emptyUaState(),
    version_tracked: { ...emptyUaState(), user_agent: factoryClientUserAgent(kind) },
    preferred: "extracted",
    remote_version: null,
    remote_version_at: null
  };
}

function emptyUaState(): ClientIdentityUaState {
  return {
    user_agent: "",
    manual: false,
    updated_at: null,
    last_success_date: null,
    last_attempt_at: null,
    last_error: null
  };
}

/**
 * Rebuilds state from whatever the file holds, field by field. The file is a
 * cache that older or newer builds may have written, so a shape mismatch has to
 * degrade to the factory default for that field rather than reject the load.
 */
function normalizeState(value: unknown): ClientIdentityState {
  if (!isRecord(value)) {
    return factoryState();
  }

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    codex: normalizeKindState(value.codex, "codex"),
    claude: normalizeKindState(value.claude, "claude")
  };
}

function normalizeKindState(value: unknown, kind: ClientIdentityKind): ClientIdentityKindState {
  const fallback = factoryKindState(kind);
  if (!isRecord(value)) {
    return fallback;
  }

  const remoteVersion = readTrimmedString(value.remote_version);
  return {
    extracted: normalizeUaState(value.extracted, ""),
    version_tracked: normalizeUaState(value.version_tracked, factoryClientUserAgent(kind)),
    preferred: value.preferred === "version_tracked" ? "version_tracked" : "extracted",
    remote_version: remoteVersion && /^\d+\.\d+\.\d+$/.test(remoteVersion) ? remoteVersion : null,
    remote_version_at: readTrimmedString(value.remote_version_at)
  };
}

function normalizeUaState(value: unknown, fallbackUserAgent: string): ClientIdentityUaState {
  if (!isRecord(value)) {
    return { ...emptyUaState(), user_agent: fallbackUserAgent };
  }

  const userAgent = readTrimmedString(value.user_agent);
  return {
    user_agent: userAgent && userAgent.length <= MAX_USER_AGENT_LENGTH && isValidHeaderValue(userAgent)
      ? userAgent
      : fallbackUserAgent,
    manual: value.manual === true,
    updated_at: readTrimmedString(value.updated_at),
    last_success_date: readTrimmedString(value.last_success_date),
    last_attempt_at: readTrimmedString(value.last_attempt_at),
    last_error: readTrimmedString(value.last_error)
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
