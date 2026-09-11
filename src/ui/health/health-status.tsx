import type { CredentialScope, CredentialSource, HealthResponse } from "../../shared/types.js";
import type { HealthBadge, HealthRouteCredentialConfig } from "../app-types.js";
import { oauthStatusLabel } from "../config/useOAuthAccounts.js";

export function credentialSourceLabel(source?: CredentialSource | null): string {
  if (source === "config") {
    return "直填密钥";
  }

  if (source === "env") {
    return "环境变量";
  }

  if (source === "oauth") {
    return "OAuth 连接";
  }

  return "未找到";
}

export function activeCredentialLabel(
  scope: CredentialScope,
  upstream?: HealthRouteCredentialConfig | null
): string {
  if (!upstream) {
    return "读取中...";
  }

  if (upstream.api_key_source === "config") {
    return upstream.active_credential_scope === scope ? "已保存直连密钥" : "复用主路由直连密钥";
  }

  if (upstream.api_key_source === "oauth") {
    return upstream.active_credential_scope === scope ? "厂商 OAuth 连接" : "复用主路由 OAuth 连接";
  }

  return upstream.active_api_key_env ?? "无";
}

export function credentialFlagCopy(
  scope: CredentialScope,
  upstream?: HealthRouteCredentialConfig | null
): string {
  if (upstream?.api_key_source === "oauth") {
    const status = upstream.oauth_status ?? "missing";
    const label = oauthStatusLabel[status];
    return status === "connected"
      ? `当前使用${upstream.active_credential_scope === scope ? "厂商" : "主路由"} OAuth 连接（${label}）。`
      : `OAuth 连接${label}，请到「档案」检查或更新授权。`;
  }

  if (!upstream?.api_key_configured) {
    return "当前没有可用密钥。";
  }

  if (upstream.api_key_source === "config") {
    return upstream.active_credential_scope === scope
      ? "当前由已保存的直连密钥注入 Authorization。"
      : "当前复用主路由里保存的直连密钥。";
  }

  return upstream.active_credential_scope === scope
    ? `当前读取环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。`
    : `当前复用主路由环境变量 ${upstream.active_api_key_env ?? upstream.api_key_env}。`;
}

export function upstreamHealthBadge(
  upstream?: HealthRouteCredentialConfig | null
): HealthBadge {
  if (!upstream) {
    return { label: "读取中", tone: "warn" };
  }

  if (upstream.status !== "configured") {
    return { label: "异常", tone: "bad" };
  }

  if (upstream.api_key_source === "oauth") {
    const status = upstream.oauth_status ?? "missing";
    if (status !== "connected" || !upstream.api_key_configured) {
      return { label: status === "expired" ? "令牌已过期" : "授权不可用", tone: "warn" };
    }
  }

  if (!upstream.api_key_configured) {
    return { label: "缺密钥", tone: "warn" };
  }

  return { label: "已配置", tone: "good" };
}

export function overallHealthBadge(health: HealthResponse | null): HealthBadge {
  if (!health) {
    return { label: "等待健康数据", tone: "warn" };
  }

  const statuses = [
    upstreamHealthBadge(health.primary),
    upstreamHealthBadge(health.compact),
    upstreamHealthBadge(health.claude.primary)
  ];

  if (statuses.some((item) => item.tone === "bad")) {
    return { label: "存在异常", tone: "bad" };
  }

  if (statuses.some((item) => item.tone === "warn")) {
    return { label: "需要补全", tone: "warn" };
  }

  return { label: "配置就绪", tone: "good" };
}
