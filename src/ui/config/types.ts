import type { ClaudeModelMap, ConfigProfileScope, PublicConfig } from "../../shared/types.js";

export type SaveState = "idle" | "saving" | "saved" | "error";

export type ProfileActionState =
  | "idle"
  | "saving"
  | "saved"
  | "updating"
  | "updated"
  | "reordering"
  | "reordered"
  | "duplicating"
  | "duplicated"
  | "deleting"
  | "deleted"
  | "applying"
  | "applied"
  | "error";

export type ConfigFormState = {
  codexPrimaryBaseUrl: string;
  codexPrimaryApiKey: string;
  clearCodexPrimaryApiKey: boolean;
  codexPrimaryCredentialPresetId: string;
  codexCompactBaseUrl: string;
  codexCompactApiKey: string;
  clearCodexCompactApiKey: boolean;
  codexCompactCredentialPresetId: string;
  claudePrimaryBaseUrl: string;
  claudePrimaryApiKey: string;
  clearClaudePrimaryApiKey: boolean;
  claudePrimaryCredentialPresetId: string;
  claudeModelMap: ClaudeModelMap;
  claudeCompactBaseUrl: string;
  claudeCompactApiKey: string;
  clearClaudeCompactApiKey: boolean;
  claudeCompactCredentialPresetId: string;
  claudeCompactModelOverride: string;
  claudeCompactUpstreamMode: "split" | "primary";
  upstreamMode: "split" | "primary";
  modelMode: "linked" | "custom";
  modelTemplate: string;
  modelOverride: string;
  autoSchedulePrimaryFailover: boolean;
};

export type ConfigTab = "profiles" | "routes" | "model" | "preview" | "portable";
export type PublicConfigProfile = PublicConfig["profiles"][number];
export type ProfileDeleteCandidate = { scope: ConfigProfileScope; profile: PublicConfigProfile };
export type ProfileDropPosition = "before" | "after";
