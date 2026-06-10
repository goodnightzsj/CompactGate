export type RouteKind = "primary" | "compact" | "claude";
export type ProviderFamily = "openai" | "claude";
export type LogStatusKind = "normal" | "error";
export type CredentialScope = "primary" | "compact" | "claude" | "claude_primary" | "claude_compact";
export type CredentialSource = "config" | "env" | "missing";
export type ConfigProfileScope = "codex" | "claude";
export type RouteUrlPresetKind = "codex_primary" | "codex_compact" | "claude_primary" | "claude_compact";
export type RequestTransport = "http" | "stream";

export type CompactModelMode = "linked" | "custom";
export type CompactUpstreamMode = "split" | "primary";
export type ClaudeModelMapRole = "default" | "opus" | "sonnet" | "haiku" | "reasoning" | "subagent";

export type ClaudeModelMap = Record<ClaudeModelMapRole, string>;

export interface UpstreamConfig {
  base_url: string;
  api_key: string;
  api_key_env: string;
}

export interface ClaudeCompactConfig extends UpstreamConfig {
  upstream_mode: CompactUpstreamMode;
  model_override: string;
}

export interface ClaudePrimaryConfig extends UpstreamConfig {
  model_override: string;
}

export interface CompactConfig extends UpstreamConfig {
  upstream_mode: CompactUpstreamMode;
  model_mode: CompactModelMode;
  model_template: string;
  model_override: string;
}

export interface ClaudeConfig {
  primary: ClaudePrimaryConfig;
  compact: ClaudeCompactConfig;
  model_map: ClaudeModelMap;
}

export interface TimeoutConfig {
  primary_ms: number;
  compact_ms: number;
  claude_ms: number;
}

export interface LoggingConfig {
  redact_body: boolean;
  keep_recent: number;
}

export interface PrimaryFailoverConfig {
  auto_schedule: boolean;
}

export interface CompactGateRuntimeConfig {
  listen: string;
  primary: UpstreamConfig;
  compact: CompactConfig;
  claude: ClaudeConfig;
  timeouts: TimeoutConfig;
  logging: LoggingConfig;
  primary_failover: PrimaryFailoverConfig;
}

export interface SavedCodexProfileConfig {
  primary: UpstreamConfig;
  compact: CompactConfig;
}

export interface SavedClaudeProfileConfig {
  claude: ClaudeConfig;
}

export type SavedConfigProfileConfig =
  | SavedCodexProfileConfig
  | SavedClaudeProfileConfig
  | CompactGateRuntimeConfig;

export interface SavedConfigProfile {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  config: SavedConfigProfileConfig;
}

export interface SavedConfigProfileScopeState {
  profiles?: SavedConfigProfile[];
  active_profile_id?: string | null;
}

export interface SavedConfigProfileScopes {
  codex?: SavedConfigProfileScopeState;
  claude?: SavedConfigProfileScopeState;
}

export interface RouteUrlPreset {
  id: string;
  kind: RouteUrlPresetKind;
  base_url: string;
  host: string;
  created_at: string;
  updated_at: string;
  usage_count: number;
}

export interface CompactGateConfig extends CompactGateRuntimeConfig {
  /** @deprecated Legacy combined profiles. Loaded as both codex and claude profile scopes. */
  profiles?: SavedConfigProfile[];
  /** @deprecated Legacy combined active profile. Loaded as both codex and claude active profile IDs. */
  active_profile_id?: string | null;
  profile_scopes?: SavedConfigProfileScopes;
  route_url_presets?: RouteUrlPreset[];
}

export interface PublicConfigProfile {
  id: string;
  scope: ConfigProfileScope;
  name: string;
  created_at: string;
  updated_at: string;
  primary_base_url: string | null;
  compact_base_url: string | null;
  claude_primary_base_url: string | null;
  claude_compact_base_url: string | null;
  primary_host: string | null;
  compact_host: string | null;
  claude_primary_host: string | null;
  claude_compact_host: string | null;
  claude_primary_model_override: string | null;
  claude_compact_model_override: string | null;
  claude_model_map: ClaudeModelMap | null;
  compact_upstream_mode: CompactUpstreamMode | null;
  claude_compact_upstream_mode: CompactUpstreamMode | null;
  stored_api_key_count: number;
}

export interface PublicCredentialState {
  api_key_env: string;
  stored_api_key: boolean;
  api_key_configured: boolean;
  api_key_source: CredentialSource;
  active_api_key_env: string | null;
  active_credential_scope: CredentialScope;
}

export interface PublicUpstreamConfig extends PublicCredentialState {
  base_url: string;
  host: string;
}

export interface PublicCompactConfig extends PublicCredentialState {
  base_url: string;
  host: string;
  upstream_mode: CompactUpstreamMode;
  model_mode: CompactModelMode;
  model_template: string;
  model_override: string;
}

export interface PublicClaudeConfig {
  primary: PublicUpstreamConfig & { model_override: string };
  compact: PublicUpstreamConfig & { upstream_mode: CompactUpstreamMode; model_override: string };
  model_map: ClaudeModelMap;
}

export interface PublicConfigProfileScopeState {
  profiles: PublicConfigProfile[];
  active_profile_id: string | null;
}

export interface PublicConfigProfileScopes {
  codex: PublicConfigProfileScopeState;
  claude: PublicConfigProfileScopeState;
}

export interface PublicConfig {
  listen: string;
  primary: PublicUpstreamConfig;
  compact: PublicCompactConfig;
  claude: PublicClaudeConfig;
  timeouts: TimeoutConfig;
  logging: LoggingConfig;
  primary_failover: PrimaryFailoverConfig;
  /** @deprecated Use profile_scopes.codex. */
  profiles: PublicConfigProfile[];
  /** @deprecated Use profile_scopes.codex.active_profile_id. */
  active_profile_id: string | null;
  profile_scopes: PublicConfigProfileScopes;
  route_url_presets: RouteUrlPreset[];
  config_path: string;
  last_saved_at: string | null;
}

export interface RoutePreviewRequest {
  method?: string;
  path: string;
  body?: unknown;
}

export interface RoutePreviewResponse {
  route: RouteKind;
  method: string;
  path: string;
  upstream_url: string;
  upstream_host: string;
  source_model: string | null;
  target_model: string | null;
  body_rewritten: boolean;
  stream_removed: boolean;
}

export interface RequestLogEntry {
  time: string;
  route: RouteKind;
  method: string;
  path: string;
  endpoint: string;
  request_type: RequestTransport;
  reasoning_effort: string | null;
  request_summary: string | null;
  source_model: string | null;
  target_model: string | null;
  status: number;
  duration_ms: number;
  first_token_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cached_output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_tokens: number | null;
  additive_cached_input_tokens: boolean;
  additive_cached_output_tokens: boolean;
  total_tokens: number | null;
  upstream_host: string;
  user_agent: string | null;
  request_id: string;
  error_summary: string | null;
}

export interface HostLogCount {
  host: string;
  total: number;
  primary: number;
  compact: number;
  claude: number;
}

export type ProviderLogCounts = Record<"all" | ProviderFamily, number>;
export type StatusLogCounts = Record<"all" | LogStatusKind, number>;

export interface RequestLogPage {
  logs: RequestLogEntry[];
  limit: number;
  offset: number;
  total: number;
  all_total: number;
  has_more: boolean;
  counts: Record<"all" | RouteKind, number>;
  provider_counts: ProviderLogCounts;
  status_counts: StatusLogCounts;
  host_counts: HostLogCount[];
}

export interface HealthResponse {
  status: "ok";
  time: string;
  listen: string;
  primary: {
    status: "configured" | "invalid";
    base_url: string;
    host: string | null;
  } & PublicCredentialState;
  compact: {
    status: "configured" | "invalid";
    base_url: string;
    host: string | null;
  } & PublicCredentialState;
  claude: {
    primary: {
      status: "configured" | "invalid";
      base_url: string;
      host: string | null;
    } & PublicCredentialState;
    compact: {
      status: "configured" | "invalid";
      base_url: string;
      host: string | null;
    } & PublicCredentialState;
  };
}

export interface StudioSnapshotEvent {
  config: PublicConfig;
  health: HealthResponse;
  logs: RequestLogEntry[];
  log_page: RequestLogPage;
}

export interface StudioLogEvent {
  entry: RequestLogEntry;
}
