import type {
  ClaudeModelMap,
  ConfigProfileScope,
  PrimaryKeyStrategy,
  PrimaryReasoningEffort,
  PrimaryStatePortabilityMode,
  PublicConfig,
  UpstreamProtocol
} from "../../shared/types.js";

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

export interface FormKeyPoolEntry {
  /** Stable handle from the saved pool; new draft entries get a fresh uuid. */
  id: string;
  label: string;
  /** Newly typed secret. Empty means "keep the stored one" — the public config
   * never returns plaintext, so the merge inherits by id on the server. */
  apiKey: string;
  enabled: boolean;
  /** Four trailing characters of the stored secret, for telling keys apart. */
  tail: string;
}

export type ConfigFormState = {
  codexPrimaryBaseUrl: string;
  codexPrimaryApiKey: string;
  clearCodexPrimaryApiKey: boolean;
  codexPrimaryCredentialPresetId: string;
  codexPrimaryUpstreamProtocol: UpstreamProtocol;
  primaryModelOverride: string;
  primaryReasoningEffort: PrimaryReasoningEffort;
  primaryStateDomainId: string;
  primaryStatePortability: PrimaryStatePortabilityMode;
  codexPrimaryApiKeys: FormKeyPoolEntry[];
  codexPrimaryKeyStrategy: PrimaryKeyStrategy;
  codexPrimaryRotationOptOut: boolean;
  codexPrimaryStickyReserveSeconds: number;
  codexCompactBaseUrl: string;
  codexCompactApiKey: string;
  clearCodexCompactApiKey: boolean;
  codexCompactCredentialPresetId: string;
  codexCompactUpstreamProtocol: UpstreamProtocol;
  claudePrimaryBaseUrl: string;
  claudePrimaryApiKey: string;
  clearClaudePrimaryApiKey: boolean;
  claudePrimaryCredentialPresetId: string;
  claudePrimaryUpstreamProtocol: UpstreamProtocol;
  claudePrimaryApiKeys: FormKeyPoolEntry[];
  claudePrimaryKeyStrategy: PrimaryKeyStrategy;
  claudePrimaryRotationOptOut: boolean;
  claudePrimaryStickyReserveSeconds: number;
  claudeModelMap: ClaudeModelMap;
  claudeCompactBaseUrl: string;
  claudeCompactApiKey: string;
  clearClaudeCompactApiKey: boolean;
  claudeCompactCredentialPresetId: string;
  claudeCompactUpstreamProtocol: UpstreamProtocol;
  claudeCompactModelOverride: string;
  claudeCompactUpstreamMode: "split" | "primary";
  upstreamMode: "split" | "primary";
  modelMode: "linked" | "custom";
  modelTemplate: string;
  modelOverride: string;
  autoSchedulePrimaryFailover: boolean;
  loggingPersistBody: boolean;
  loggingKeepRecent: number;
  loggingCaptureDir: string;
  loggingCaptureBodyMaxMiB: number;
  loggingCaptureDirMaxGiB: number;
  loggingMaxDatabaseMiB: number;
};

export type ConfigTab =
  | "profiles"
  | "routes"
  | "model"
  | "logging"
  | "preview"
  | "portable";
export type PublicConfigProfile = PublicConfig["profiles"][number];
export type ProfileDeleteCandidate = { scope: ConfigProfileScope; profile: PublicConfigProfile };
export type ProfileOverwriteCandidate = {
  scope: ConfigProfileScope;
  profile: PublicConfigProfile;
  suggestedName: string;
};
export type ProfileDropPosition = "before" | "after";
