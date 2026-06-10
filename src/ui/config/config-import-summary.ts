import type { ConfigProfileScope } from "../../shared/types.js";

export type ImportState = "idle" | "ready" | "importing" | "imported" | "error";

export type ConfigImportSummary = {
  listen: string;
  codexPrimaryHost: string;
  codexCompactHost: string;
  claudePrimaryHost: string;
  codexProfileCount: number;
  claudeProfileCount: number;
  presetCount: number;
  keepRecent: number | null;
  hasDirectApiKeys: boolean;
};

export type ImportCandidate = {
  fileName: string;
  sizeBytes: number;
  config: Record<string, unknown>;
  summary: ConfigImportSummary;
};

export function summarizeConfigImport(config: Record<string, unknown>): ConfigImportSummary {
  const logging = readRecord(config.logging);
  return {
    listen: typeof config.listen === "string" && config.listen.trim() ? config.listen.trim() : "默认或未声明",
    codexPrimaryHost: hostLabel(readNestedString(config, ["primary", "base_url"])),
    codexCompactHost: hostLabel(readNestedString(config, ["compact", "base_url"])),
    claudePrimaryHost: hostLabel(readNestedString(config, ["claude", "primary", "base_url"])),
    codexProfileCount: countProfiles(config, "codex"),
    claudeProfileCount: countProfiles(config, "claude"),
    presetCount: Array.isArray(config.route_url_presets) ? config.route_url_presets.length : 0,
    keepRecent: typeof logging?.keep_recent === "number" ? logging.keep_recent : null,
    hasDirectApiKeys: hasDirectApiKey(config)
  };
}

function countProfiles(config: Record<string, unknown>, scope: ConfigProfileScope): number {
  const profileScopes = readRecord(config.profile_scopes);
  const scopeState = readRecord(profileScopes?.[scope]);
  const scopedProfiles = scopeState?.profiles;
  if (Array.isArray(scopedProfiles)) {
    return scopedProfiles.length;
  }

  return scope === "codex" && Array.isArray(config.profiles) ? config.profiles.length : 0;
}

function hasDirectApiKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasDirectApiKey);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([key, child]) => {
    if (key === "api_key") {
      return typeof child === "string" && child.trim().length > 0;
    }

    return hasDirectApiKey(child);
  });
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[part];
  }

  return typeof current === "string" ? current : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function hostLabel(value: string | null): string {
  if (!value || !value.trim()) {
    return "默认或未声明";
  }

  try {
    return new URL(value).host;
  } catch {
    return "无效 URL";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
