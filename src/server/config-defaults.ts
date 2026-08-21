import type {
  ClaudeModelMap,
  ClaudeModelMapRole,
  ClaudeSceneMap,
  ClaudeScene,
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

export const CLAUDE_SCENES: ClaudeScene[] = [
  "default",
  "long_context",
  "background",
  "web_search",
  "thinking",
  "image"
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

export function emptyClaudeSceneMap(): ClaudeSceneMap {
  return Object.fromEntries(CLAUDE_SCENES.map((scene) => [scene, {
    profile_id: "",
    model: ""
  }])) as ClaudeSceneMap;
}

export const DEFAULT_CONFIG: CompactGateConfig = {
  listen: "127.0.0.1:7865",
  primary: {
    base_url: "https://primary.example/v1",
    api_key: "",
    api_key_env: "",
    extra_headers: {},
    proxy_url: "",
    upstream_protocol: "openai_responses",
    model_override: "",
    reasoning_effort: "",
    state_domain_id: ""
  },
  compact: {
    base_url: "https://compact.example/v1",
    api_key: "",
    api_key_env: "",
    extra_headers: {},
    proxy_url: "",
    upstream_protocol: "openai_responses",
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
      extra_headers: {},
      proxy_url: "",
      upstream_protocol: "anthropic_messages",
      model_override: ""
    },
    compact: {
      base_url: "https://api.anthropic.com",
      api_key: "",
      api_key_env: "ANTHROPIC_AUTH_TOKEN",
      extra_headers: {},
      proxy_url: "",
      upstream_protocol: "anthropic_messages",
      upstream_mode: "primary",
      model_override: ""
    },
    model_map: emptyClaudeModelMap(),
    scene_map: emptyClaudeSceneMap(),
    long_context_bytes: 0
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
    capture_body_max_bytes: 8 * 1024 * 1024,
    capture_dir_max_bytes: 20 * 1024 * 1024 * 1024,
    max_database_bytes: 1024 * 1024 * 1024
  },
  primary_failover: {
    auto_schedule: true,
    state_portability: "recover_on_error"
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
