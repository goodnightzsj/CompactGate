export type RouteKind = "primary" | "compact";
export type CredentialScope = "primary" | "compact";
export type CredentialSource = "config" | "env" | "missing";

export type CompactModelMode = "linked" | "custom";
export type CompactUpstreamMode = "split" | "primary";

export interface UpstreamConfig {
  base_url: string;
  api_key: string;
  api_key_env: string;
}

export interface CompactConfig extends UpstreamConfig {
  upstream_mode: CompactUpstreamMode;
  model_mode: CompactModelMode;
  model_template: string;
  model_override: string;
}

export interface TimeoutConfig {
  primary_ms: number;
  compact_ms: number;
}

export interface LoggingConfig {
  redact_body: boolean;
  keep_recent: number;
}

export interface CompactGateConfig {
  listen: string;
  primary: UpstreamConfig;
  compact: CompactConfig;
  timeouts: TimeoutConfig;
  logging: LoggingConfig;
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

export interface PublicConfig {
  listen: string;
  primary: PublicUpstreamConfig;
  compact: PublicCompactConfig;
  timeouts: TimeoutConfig;
  logging: LoggingConfig;
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
  source_model: string | null;
  target_model: string | null;
  status: number;
  duration_ms: number;
  upstream_host: string;
  request_id: string;
  error_summary: string | null;
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
}

export interface StudioSnapshotEvent {
  config: PublicConfig;
  health: HealthResponse;
  logs: RequestLogEntry[];
}

export interface StudioLogEvent {
  entry: RequestLogEntry;
}
