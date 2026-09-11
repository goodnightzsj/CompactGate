import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthEndpointCard } from "../src/ui/health/HealthEndpointCard.js";
import { HealthHeroSection } from "../src/ui/health/HealthHeroSection.js";
import type { HealthRouteCredentialConfig } from "../src/ui/app-types.js";

describe("health presentation", () => {
  it.each(["connected", "expired", "needs_reauth", "disconnected", "missing"] as const)("identifies OAuth credentials and %s status without environment-key advice", (oauthStatus) => {
    const configured = oauthStatus === "connected" || oauthStatus === "expired";
    const markup = renderToStaticMarkup(<HealthEndpointCard
      title="Codex 压缩路由" route="compact" credentialScope="compact"
      badgeLabel="Codex" summary="压缩请求"
      upstream={{ status: "configured", base_url: "https://synthetic.example/v1", host: "synthetic.example",
        api_key_env: "UNUSED_SYNTHETIC_KEY", api_key_configured: configured, api_key_source: "oauth",
        stored_api_key: false, stored_api_key_tail: "", active_api_key_env: null,
        active_credential_scope: "primary", oauth_status: oauthStatus }}
    />);
    expect(markup).toContain("OAuth 连接");
    expect(markup).not.toContain("当前读取环境变量");
    expect(markup).not.toContain("主路由环境变量");
    expect(markup).not.toContain("缺密钥");
    if (oauthStatus === "connected") {
      expect(markup).toContain("已授权");
      expect(markup).toContain("复用主路由 OAuth 连接");
    } else {
      expect(markup).toMatch(/<details[^>]*open/);
      expect(markup).toContain("请到「档案」");
      expect(markup).toContain(oauthStatus === "expired" ? "令牌已过期" : "授权不可用");
    }
  });

  it.each([true, false])("discloses credentials according to readiness (%s)", (configured) => {
    const upstream = {
      status: "configured",
      base_url: "https://synthetic.example/v1",
      host: "synthetic.example",
      api_key_configured: configured,
      api_key_source: configured ? "config" : "missing",
      stored_api_key: configured,
      active_credential_scope: "primary"
    } as HealthRouteCredentialConfig;
    const markup = renderToStaticMarkup(<HealthEndpointCard
      title="Codex 主路由" route="primary" credentialScope="primary"
      badgeLabel="Codex" summary="普通请求" upstream={upstream}
    />);
    expect(markup).toContain("https://synthetic.example/v1");
    expect(markup).toContain("当前读取");
    const tag = markup.match(/<details[^>]*>/)?.[0] ?? "";
    if (configured) {
      expect(tag).not.toContain("open");
      expect(markup).toContain("已保存直连密钥");
    } else {
      expect(tag).toContain("open");
      expect(markup).toContain("缺密钥");
      expect(markup).toContain("当前没有可用密钥。");
    }
  });

  it("keeps the unverified-connectivity caveat visible even with an unhealthy route", () => {
    const markup = renderToStaticMarkup(<HealthHeroSection
      overallStatus={{ tone: "warn", label: "需要补全" }}
      readyRoutes={2} attentionRoutes={1} failedRoutes={0} totalRoutes={3}
      listenUrl="http://127.0.0.1:7865" refreshedAt="2026-09-08T03:00:00.000Z"
      isRefreshing={false}
    />);
    expect(markup).toContain("1 条需要补全");
    expect(markup).toContain("未验证连通性");
    expect(markup.match(/刷新于/g)).toHaveLength(1);
  });
});
