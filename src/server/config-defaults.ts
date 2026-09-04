import type {
  ClaudeModelMap,
  ClaudeModelMapRole,
  ClaudeSceneMap,
  ClaudeScene,
  ClientIdentityKind,
  CompactGateConfig
} from "../shared/types.js";

/**
 * Factory User-Agents for the version-tracked source, used until a real CLI
 * request is observed. Both are real UAs taken from the request log, with the
 * fork's `-cometix` build tag stripped.
 *
 * These carry the OS and terminal of the machine they were captured on, which is
 * the cost of the full form: a Linux operator introduces itself as macOS + iTerm
 * until the first native CLI request replaces this with their own. The trade was
 * deliberate — the full form matches what real TUI traffic looks like, and the
 * bare `codex-cli/x.y.z` form is comparatively rare in observed traffic.
 */
const FACTORY_USER_AGENTS: Record<ClientIdentityKind, string> = {
  codex: "codex-tui/0.144.3 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.3)",
  claude: "claude-cli/2.1.234 (external, cli)"
};

export function factoryClientUserAgent(kind: ClientIdentityKind): string {
  return FACTORY_USER_AGENTS[kind];
}

/** npm packages whose `latest` version each CLI's UA tracks. */
export const CLIENT_IDENTITY_REGISTRY_PACKAGES: Record<ClientIdentityKind, string> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code"
};

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
    state_domain_id: "",
    key_strategy: "fill_first",
    rotation_opt_out: false,
    sticky_reserve_seconds: 0
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
      model_override: "",
      key_strategy: "fill_first",
      rotation_opt_out: false,
      sticky_reserve_seconds: 0
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
