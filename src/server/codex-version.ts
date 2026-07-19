import { spawnSync } from "node:child_process";
import type { RequestLogEntry } from "../shared/types.js";

export const CODEX_REMOTE_V2_DEFAULT_FROM = "0.140.0";
export const CODEX_PROTOCOL_LOG_LIMIT = 200;
const DEFAULT_VERSION_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export type CodexObservedProtocol = "local" | "remote_v1" | "remote_v2";
export type CodexProtocolSummary = CodexObservedProtocol | "mixed" | "unknown";
export type CodexProtocolConfidence = "observed" | "inferred" | "unknown";
export type CodexProtocolSource = "request" | "version_baseline" | "none";

export interface CodexClientInfo {
  name: string;
  raw_version: string;
  base_version: string | null;
  variant: string | null;
  is_fork: boolean;
}

export interface CodexObservedClient extends CodexClientInfo {
  last_observed_at: string;
  protocols: CodexObservedProtocol[];
}

export interface CodexVersionStatus {
  local_client: CodexClientInfo | null;
  local_source: "local_cli" | "unavailable";
  last_checked_at: string | null;
  observed_clients: CodexObservedClient[];
  observed_protocol: CodexProtocolSummary;
  observed_at: string | null;
  protocol_source: CodexProtocolSource;
  confidence: CodexProtocolConfidence;
  v2_default_from: string;
}

interface CodexVersionMonitorOptions {
  intervalMs?: number;
  probeTimeoutMs?: number;
  command?: string;
  now?: () => Date;
  probe?: () => string | null;
}

interface ObservedClientState {
  client: CodexClientInfo;
  lastObservedAt: string;
  protocols: Set<CodexObservedProtocol>;
}

export function parseCodexClientUserAgent(value: string | null | undefined): CodexClientInfo | null {
  if (!value) {
    return null;
  }

  const match = value.match(/(?:^|\s)(codex(?:-tui|-cli)?)[\/: ]([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9][A-Za-z0-9.-]*)?)/i);
  if (!match) {
    return null;
  }

  return parseCodexClientVersion(match[1], match[2]);
}

export function parseCodexVersionOutput(value: string | null | undefined): CodexClientInfo | null {
  if (!value) {
    return null;
  }

  const match = value.match(/(?:^|\s)(codex(?:-tui|-cli)?)[\s\/:]+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9][A-Za-z0-9.-]*)?)/i);
  return match ? parseCodexClientVersion(match[1], match[2]) : null;
}

export function parseCodexClientVersion(name: string, rawVersion: string): CodexClientInfo {
  const match = rawVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([A-Za-z0-9][A-Za-z0-9.-]*))?$/);
  const baseVersion = match ? `${match[1]}.${match[2]}.${match[3]}` : null;
  const variant = match?.[4] ?? null;
  return {
    name,
    raw_version: rawVersion,
    base_version: baseVersion,
    variant,
    is_fork: variant !== null
  };
}

export function effectiveCodexProtocol(baseVersion: string | null): CodexObservedProtocol | null {
  if (!baseVersion) {
    return null;
  }

  const match = baseVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  const [major, minor, patch] = match.slice(1).map(Number);
  const [boundaryMajor, boundaryMinor, boundaryPatch] = CODEX_REMOTE_V2_DEFAULT_FROM
    .split(".")
    .map(Number);
  const isV2 = major > boundaryMajor ||
    (major === boundaryMajor && (minor > boundaryMinor || (minor === boundaryMinor && patch >= boundaryPatch)));
  return isV2 ? "remote_v2" : "remote_v1";
}

export class CodexVersionMonitor {
  private readonly intervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly command: string;
  private readonly now: () => Date;
  private readonly probe: () => string | null;
  private localClient: CodexClientInfo | null = null;
  private localSource: "local_cli" | "unavailable" = "unavailable";
  private lastCheckedAt: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CodexVersionMonitorOptions = {}) {
    this.intervalMs = normalizeInterval(options.intervalMs, DEFAULT_VERSION_POLL_INTERVAL_MS);
    this.probeTimeoutMs = normalizeInterval(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
    this.command = options.command ?? "codex";
    this.now = options.now ?? (() => new Date());
    this.probe = options.probe ?? (() => probeCodexVersion(this.command, this.probeTimeoutMs));
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.refreshLocalVersion();
    this.timer = setInterval(() => this.refreshLocalVersion(), this.intervalMs);
    this.timer.unref?.();
  }

  close(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  refreshLocalVersion(): void {
    const checkedAt = this.now().toISOString();
    this.lastCheckedAt = checkedAt;
    const output = this.probe();
    const client = parseCodexVersionOutput(output);
    if (!client) {
      this.localClient = null;
      this.localSource = "unavailable";
      return;
    }

    this.localClient = client;
    this.localSource = "local_cli";
  }

  snapshot(logs: readonly Pick<RequestLogEntry, "user_agent" | "compaction_mode" | "time">[] = []): CodexVersionStatus {
    const observedClientsByKey = new Map<string, ObservedClientState>();
    const observedProtocols = new Set<CodexObservedProtocol>();
    let observedAt: string | null = null;
    for (const entry of logs) {
      if (!entry.compaction_mode) {
        continue;
      }

      observedProtocols.add(entry.compaction_mode);
      if (observedAt === null || entry.time > observedAt) {
        observedAt = entry.time;
      }

      const client = parseCodexClientUserAgent(entry.user_agent);
      if (!client) {
        continue;
      }

      const current = observedClientsByKey.get(observedClientKey(client));
      const next: ObservedClientState = current ?? {
        client,
        lastObservedAt: entry.time,
        protocols: new Set<CodexObservedProtocol>()
      };
      next.client = client;
      if (entry.time >= next.lastObservedAt) {
        next.lastObservedAt = entry.time;
      }
      next.protocols.add(entry.compaction_mode);
      observedClientsByKey.set(observedClientKey(client), next);
    }

    const observedClients = [...observedClientsByKey.values()]
      .sort((left, right) => right.lastObservedAt.localeCompare(left.lastObservedAt))
      .slice(0, 8)
      .map((item) => ({
        ...item.client,
        last_observed_at: item.lastObservedAt,
        protocols: [...item.protocols].sort()
      }));
    const observedProtocol = summarizeProtocols(observedProtocols);
    if (observedProtocol !== "unknown") {
      return {
        local_client: this.localClient,
        local_source: this.localSource,
        last_checked_at: this.lastCheckedAt,
        observed_clients: observedClients,
        observed_protocol: observedProtocol,
        observed_at: observedAt,
        protocol_source: "request",
        confidence: "observed",
        v2_default_from: CODEX_REMOTE_V2_DEFAULT_FROM
      };
    }

    const inferredProtocol = effectiveCodexProtocol(this.localClient?.base_version ?? null);
    return {
      local_client: this.localClient,
      local_source: this.localSource,
      last_checked_at: this.lastCheckedAt,
      observed_clients: observedClients,
      observed_protocol: inferredProtocol ?? "unknown",
      observed_at: observedAt,
      protocol_source: inferredProtocol ? "version_baseline" : "none",
      confidence: inferredProtocol ? "inferred" : "unknown",
      v2_default_from: CODEX_REMOTE_V2_DEFAULT_FROM
    };
  }
}

function observedClientKey(client: CodexClientInfo): string {
  return `${client.name}:${client.raw_version}`;
}

function summarizeProtocols(protocols: Set<CodexObservedProtocol>): CodexProtocolSummary {
  if (protocols.size === 0) {
    return "unknown";
  }

  if (protocols.size === 1) {
    return [...protocols][0];
  }

  return "mixed";
}

function normalizeInterval(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback;
}

function probeCodexVersion(command: string, timeoutMs: number): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}
