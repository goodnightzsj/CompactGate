import type {
  ClaudeModelMap,
  ClaudeModelMapRole,
  CompactGateConfig
} from "../shared/types.js";

export const CLAUDE_MODEL_MAP_ROLES: ClaudeModelMapRole[] = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "reasoning",
  "subagent"
];

export function emptyClaudeModelMap(): ClaudeModelMap {
  return {
    default: "",
    opus: "",
    sonnet: "",
    haiku: "",
    reasoning: "",
    subagent: ""
  };
}

export const DEFAULT_CONFIG: CompactGateConfig = {
  listen: "127.0.0.1:7865",
  primary: {
    base_url: "https://primary.example/v1",
    api_key: "",
    api_key_env: "",
    model_override: "",
    reasoning_effort: ""
  },
  compact: {
    base_url: "https://compact.example/v1",
    api_key: "",
    api_key_env: "",
    upstream_mode: "split",
    model_mode: "linked",
    model_template: "{model}-openai-compact",
    model_override: ""
  },
  claude: {
    primary: {
      base_url: "https://api.anthropic.com",
      api_key: "",
      api_key_env: "ANTHROPIC_AUTH_TOKEN",
      model_override: ""
    },
    compact: {
      base_url: "https://api.anthropic.com",
      api_key: "",
      api_key_env: "ANTHROPIC_AUTH_TOKEN",
      upstream_mode: "primary",
      model_override: ""
    },
    model_map: emptyClaudeModelMap()
  },
  timeouts: {
    primary_ms: 120_000,
    compact_ms: 900_000,
    claude_ms: 900_000
  },
  logging: {
    redact_body: true,
    persist_body: false,
    keep_recent: 200,
    capture_dir: null,
    capture_body_max_bytes: 1024 * 1024,
    capture_dir_max_bytes: 20 * 1024 * 1024 * 1024,
    max_database_bytes: 1024 * 1024 * 1024
  },
  primary_failover: {
    auto_schedule: true
  },
  profile_scopes: {
    codex: {
      profiles: [],
      active_profile_id: null
    },
    claude: {
      profiles: [],
      active_profile_id: null
    }
  },
  route_url_presets: []
};
