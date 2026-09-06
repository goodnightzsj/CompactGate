import fs from "node:fs/promises";
import { validateHeaderValue } from "node:http";
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

  private committedState: ClientIdentityState = this.state;

  private timer: ReturnType<typeof setInterval> | null = null;

  private writing: Promise<void> = Promise.resolve();

  private refreshing = false;

  private loading: Promise<void> | null = null;

  private starting: Promise<void> | null = null;

  private readonly changeListeners = new Set<() => void>();

  private closed = false;

  constructor(options: ClientIdentityStoreOptions) {
    this.statePath = options.statePath;
    this.now = options.now ?? (() => new Date());
    this.fetchLatestVersion = options.fetchLatestVersion ?? fetchLatestRegistryVersion;
    this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS;
  }

  /**
   * Reads persisted state, starts the loop, and runs whatever refresh is owed.
   * The loop ticks far more often than it acts: `refreshDue` decides per source
   * whether anything is owed, so a long-running process refreshes shortly after
   * midnight instead of 24 hours after it happened to start.
   *
   * Callers that need only local readiness can await `load`; `start` additionally
   * waits for the initial registry refresh.
   */
  start(): Promise<void> {
    this.starting ??= this.startInternal();
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    await this.load();
    if (this.closed) {
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refreshDue().catch(reportBackgroundIdentityError);
      }, this.tickIntervalMs);
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
    this.changeListeners.clear();
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

  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
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
    if (!trimmed || trimmed.length > MAX_USER_AGENT_LENGTH || !isValidHeaderValue(trimmed)) {
      return;
    }

    const source = this.state[kind].extracted;
    if (source.manual || source.last_success_date === this.today()) {
      return;
    }

    const normalized = stripUserAgentVariants(trimmed);
    const at = this.now().toISOString();
    const today = this.today();
    const next = withSource(this.state, kind, "extracted", {
      user_agent: normalized,
      manual: false,
      updated_at: at,
      last_success_date: today,
      last_attempt_at: at,
      last_error: null
    });
    this.state = next;
    void this.persist((state) => {
      const current = state[kind].extracted;
      if (current.manual || current.last_success_date === today) {
        return state;
      }
      return withSource(state, kind, "extracted", {
        user_agent: normalized,
        manual: false,
        updated_at: at,
        last_success_date: today,
        last_attempt_at: at,
        last_error: null
      });
    }, true).catch((error) => {
      this.state = this.committedState;
      reportBackgroundIdentityError(error);
    });
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
    await this.load();
    const validated: ClientIdentityPatch = { enabled: patch.enabled };
    for (const kind of CLIENT_IDENTITY_KINDS) {
      const value = patch[kind];
      if (value) {
        validated[kind] = {
          ...value,
          extracted_user_agent: validateManualUserAgent(value.extracted_user_agent),
          version_tracked_user_agent: validateManualUserAgent(value.version_tracked_user_agent)
        };
      }
    }
    await this.persist((state) => {
      let next = state;
      if (typeof validated.enabled === "boolean") {
        next = { ...next, enabled: validated.enabled };
      }

      for (const kind of CLIENT_IDENTITY_KINDS) {
        const kindPatch = validated[kind];
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
      return next;
    });
    return this.status();
  }

  /** Operator-triggered refresh; bypasses the once-a-day gate. */
  async refreshNow(kind?: ClientIdentityKind): Promise<ClientIdentityStatus> {
    await this.load();
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

    await this.persist((state) => {
      if (state[kind].version_tracked !== source) {
        return state;
      }
      if (!version) {
        return withSource(state, kind, "version_tracked", {
          ...source,
          last_attempt_at: attemptedAt,
          last_error: error
        });
      }
      return {
        ...state,
        [kind]: {
          ...state[kind],
          remote_version: version,
          remote_version_at: attemptedAt,
          version_tracked: {
            ...source,
            updated_at: attemptedAt,
            last_success_date: this.today(),
            last_attempt_at: attemptedAt,
            last_error: null
          }
        }
      };
    }, !force);
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

  /** One shared local-read barrier; a concurrent start must not bypass it. */
  load(): Promise<void> {
    this.loading ??= fs.readFile(this.statePath, "utf8")
      .then((raw) => {
        this.state = normalizeState(JSON.parse(raw) as unknown);
        this.committedState = this.state;
      })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          // The first run has no state file yet; factory values are the contract.
          this.state = factoryState();
          this.committedState = this.state;
          return;
        }
        throw new Error(`Could not load client identity state from ${this.statePath}.`, { cause: error });
      });
    return this.loading;
  }

  /**
   * Apply each change to the last committed state inside the write queue. A
   * failed write never becomes the baseline of a later update or observation.
   */
  private persist(
    update: (state: ClientIdentityState) => ClientIdentityState,
    notify = false
  ): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }

    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) {
          return;
        }
        const next = update(this.committedState);
        if (next === this.committedState) {
          return;
        }
        await writeJsonAtomically(this.statePath, next);
        this.committedState = next;
        this.state = next;
        if (notify) {
          this.emitChange();
        }
      });
    return this.writing;
  }

  private emitChange(): void {
    if (!this.closed) {
      for (const listener of this.changeListeners) {
        listener();
      }
    }
  }
}

function reportBackgroundIdentityError(error: unknown): void {
  console.error("Failed to persist automatic client identity state.", error);
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

  return withSource(state, kind, source, {
    user_agent: value,
    manual: true,
    updated_at: at.toISOString(),
    last_success_date: state[kind][source].last_success_date,
    last_attempt_at: state[kind][source].last_attempt_at,
    last_error: null
  });
}

export class ClientIdentityValueError extends Error {}

function validateManualUserAgent(value: string | null | undefined): string | null | undefined {
  if (typeof value !== "string") {
    return value;
  }
  const userAgent = value.trim();
  if (userAgent.length > MAX_USER_AGENT_LENGTH) {
    throw new ClientIdentityValueError(
      `user-agent must be at most ${MAX_USER_AGENT_LENGTH} characters.`
    );
  }
  if (!isValidHeaderValue(value)) {
    throw new ClientIdentityValueError("user-agent must be a valid HTTP header value.");
  }
  return userAgent;
}

function isValidHeaderValue(value: string): boolean {
  try {
    validateHeaderValue("user-agent", value);
    return true;
  } catch {
    return false;
  }
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
 * Missing fields keep their defaults, but malformed operator settings must not
 * turn a saved disabled/manual policy into the factory policy.
 */
function normalizeState(value: unknown): ClientIdentityState {
  if (!isRecord(value)) {
    throw new Error("Client identity state must be an object.");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("Client identity enabled must be a boolean.");
  }

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    codex: normalizeKindState(value.codex, "codex"),
    claude: normalizeKindState(value.claude, "claude")
  };
}

function normalizeKindState(value: unknown, kind: ClientIdentityKind): ClientIdentityKindState {
  const fallback = factoryKindState(kind);
  if (value === undefined) {
    return fallback;
  }
  if (!isRecord(value)) {
    throw new Error(`Client identity ${kind} must be an object.`);
  }
  if (value.preferred !== undefined && value.preferred !== "extracted" && value.preferred !== "version_tracked") {
    throw new Error(`Client identity ${kind} has an invalid preferred source.`);
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
  if (value === undefined) {
    return { ...emptyUaState(), user_agent: fallbackUserAgent };
  }
  if (!isRecord(value) || (value.manual !== undefined && typeof value.manual !== "boolean")) {
    throw new Error("Client identity source must be an object with a boolean manual flag.");
  }
  const userAgent = value.user_agent === undefined ? fallbackUserAgent : value.user_agent;
  if (typeof userAgent !== "string" || userAgent.trim().length > MAX_USER_AGENT_LENGTH || !isValidHeaderValue(userAgent)) {
    throw new Error("Stored user-agent must be a valid HTTP header value of at most 512 characters.");
  }
  return {
    user_agent: userAgent.trim(),
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
