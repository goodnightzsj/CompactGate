import type { UpstreamProtocol } from "./types.js";

export type OAuthProviderId =
  | "openai-codex"
  | "google-vertex"
  | "qwen-code"
  | "kimi-code"
  | "xai"
  | "github-copilot"
  | "openrouter";
export type OAuthMethod = "browser" | "device_code";
export type OAuthAccountStatus = "connected" | "expired" | "needs_reauth" | "disconnected" | "missing";

export interface OAuthProviderInfo {
  id: OAuthProviderId;
  name: string;
  description: string;
  methods: OAuthMethod[];
  protocol: UpstreamProtocol;
  documentation_url: string;
}

export const OAUTH_PROVIDERS: readonly OAuthProviderInfo[] = [
  {
    id: "openai-codex", name: "OpenAI · ChatGPT Codex",
    description: "使用 ChatGPT 的 Codex 权限；与 OpenAI Platform API 额度分开。设备码登录需在账号或工作区开启。",
    methods: ["browser", "device_code"], protocol: "openai_responses",
    documentation_url: "https://developers.openai.com/codex/auth"
  },
  {
    id: "google-vertex", name: "Google · Gemini / Vertex AI",
    description: "使用自有 OAuth 桌面客户端和 Cloud 项目，按项目权限与账单调用；不是 Gemini 消费者订阅。",
    methods: ["browser"], protocol: "openai_chat",
    documentation_url: "https://cloud.google.com/vertex-ai/generative-ai/docs/start/openai"
  },
  {
    id: "qwen-code", name: "Alibaba · Qwen Code",
    description: "通过 Qwen Code 设备授权连接，模型可用性与额度由账号决定。",
    methods: ["device_code"], protocol: "openai_chat",
    documentation_url: "https://github.com/QwenLM/qwen-code"
  },
  {
    id: "kimi-code", name: "Moonshot · Kimi Code",
    description: "连接 Kimi Code 账号，使用 Coding 端点及套餐内可用模型。",
    methods: ["device_code"], protocol: "anthropic_messages",
    documentation_url: "https://www.kimi.com/code/docs/"
  },
  {
    id: "xai", name: "xAI · Grok",
    description: "通过设备码授权；是否可调用模型取决于账号授予的 API 权限。",
    methods: ["device_code"], protocol: "openai_chat",
    documentation_url: "https://docs.x.ai/"
  },
  {
    id: "github-copilot", name: "GitHub · Copilot",
    description: "连接 github.com 上的 Copilot 权限，不会自动开启被组织策略禁用的模型。",
    methods: ["device_code"], protocol: "openai_chat",
    documentation_url: "https://docs.github.com/en/copilot"
  },
  {
    id: "openrouter", name: "OpenRouter",
    description: "使用 PKCE 授权生成由你控制的 API key；它不是可自动续期的订阅令牌。",
    methods: ["browser"], protocol: "openai_chat",
    documentation_url: "https://openrouter.ai/docs/guides/overview/auth/oauth"
  }
];

export interface OAuthAccountView {
  id: string;
  provider: OAuthProviderId;
  label: string;
  base_url: string;
  upstream_protocol: UpstreamProtocol;
  status: OAuthAccountStatus;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  can_refresh: boolean;
  error: string | null;
}

export interface OAuthSessionView {
  id: string;
  provider: OAuthProviderId;
  method: OAuthMethod;
  status: "pending" | "exchanging" | "connected" | "cancelled" | "expired" | "error";
  authorization_url: string;
  user_code: string | null;
  expires_at: string;
  poll_after_ms: number;
  account_id: string | null;
  error: string | null;
}

export interface OAuthStartInput {
  provider: OAuthProviderId;
  method: OAuthMethod;
  label: string;
  settings?: {
    client_id?: string;
    client_secret?: string;
    project_id?: string;
    location?: string;
  };
}
