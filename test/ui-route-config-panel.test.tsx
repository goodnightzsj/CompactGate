import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteConfigPanel } from "../src/ui/config/RouteConfigPanel.js";
import {
  copyProfileRoutesToOtherDraft,
  emptyForm
} from "../src/ui/config/config-form-state.js";
import type { ConfigFormState } from "../src/ui/config/types.js";
import type { PublicConfig } from "../src/shared/types.js";

describe("RouteConfigPanel", () => {
  it("shows one controlled upstream protocol selector for every route", () => {
    const form = emptyForm();
    const setForm: Dispatch<SetStateAction<ConfigFormState>> = () => undefined;
    const markup = renderToStaticMarkup(
      <RouteConfigPanel config={null} form={form} onFormChange={setForm} />
    );

    expect(markup).toContain("Codex 主路由 上游格式");
    expect(markup).toContain("Codex 压缩路由 上游格式");
    expect(markup).toContain("Claude 主路由 上游格式");
    expect(markup).toContain("Claude 压缩路由 上游格式");
    expect(markup).toContain("Claude 压缩上游模式");
    expect(markup.match(/OpenAI Responses/g)).toHaveLength(2);
    expect(markup.match(/Anthropic Messages/g)).toHaveLength(2);
  });

  it("copies Codex route values into the Claude draft without copying credentials", () => {
    const form = {
      ...emptyForm(),
      codexPrimaryApiKey: "source-primary-secret",
      codexCompactApiKey: "source-compact-secret",
      claudePrimaryApiKey: "destination-primary-secret",
      claudeCompactApiKey: "destination-compact-secret",
      claudePrimaryCredentialPresetId: "claude-primary-preset",
      claudeCompactCredentialPresetId: "claude-compact-preset"
    };
    const copied = copyProfileRoutesToOtherDraft(form, codexProfile());

    expect(copied).toMatchObject({
      claudePrimaryBaseUrl: "https://codex-primary.example/v1",
      claudePrimaryUpstreamProtocol: "anthropic_messages",
      claudeCompactBaseUrl: "https://codex-compact.example/v1",
      claudeCompactUpstreamProtocol: "openai_chat",
      claudeCompactUpstreamMode: "split",
      claudePrimaryCredentialPresetId: "",
      claudeCompactCredentialPresetId: "",
      claudePrimaryApiKey: "destination-primary-secret",
      claudeCompactApiKey: "destination-compact-secret",
      codexPrimaryApiKey: "source-primary-secret",
      codexCompactApiKey: "source-compact-secret"
    });
  });

  it("copies Claude route values into the Codex draft without copying credentials", () => {
    const form = {
      ...emptyForm(),
      codexPrimaryApiKey: "destination-primary-secret",
      codexCompactApiKey: "destination-compact-secret",
      claudePrimaryApiKey: "source-primary-secret",
      claudeCompactApiKey: "source-compact-secret"
    };
    const copied = copyProfileRoutesToOtherDraft(form, claudeProfile());

    expect(copied).toMatchObject({
      codexPrimaryBaseUrl: "https://claude-primary.example",
      codexPrimaryUpstreamProtocol: "openai_responses",
      codexCompactBaseUrl: "https://claude-compact.example",
      codexCompactUpstreamProtocol: "anthropic_messages",
      upstreamMode: "primary",
      codexPrimaryApiKey: "destination-primary-secret",
      codexCompactApiKey: "destination-compact-secret",
      claudePrimaryApiKey: "source-primary-secret",
      claudeCompactApiKey: "source-compact-secret"
    });
  });
});

function codexProfile(): PublicConfig["profiles"][number] {
  return {
    ...baseProfile(),
    scope: "codex",
    primary_base_url: "https://codex-primary.example/v1",
    compact_base_url: "https://codex-compact.example/v1",
    primary_host: "codex-primary.example",
    compact_host: "codex-compact.example",
    compact_upstream_mode: "split",
    primary_upstream_protocol: "anthropic_messages",
    compact_upstream_protocol: "openai_chat"
  };
}

function claudeProfile(): PublicConfig["profiles"][number] {
  return {
    ...baseProfile(),
    scope: "claude",
    claude_primary_base_url: "https://claude-primary.example",
    claude_compact_base_url: "https://claude-compact.example",
    claude_primary_host: "claude-primary.example",
    claude_compact_host: "claude-compact.example",
    claude_compact_upstream_mode: "primary",
    claude_primary_upstream_protocol: "openai_responses",
    claude_compact_upstream_protocol: "anthropic_messages"
  };
}

function baseProfile(): PublicConfig["profiles"][number] {
  return {
    id: "profile-id",
    scope: "codex",
    name: "Profile",
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    primary_base_url: null,
    primary_state_domain_id: null,
    compact_base_url: null,
    claude_primary_base_url: null,
    claude_compact_base_url: null,
    primary_host: null,
    compact_host: null,
    claude_primary_host: null,
    claude_compact_host: null,
    claude_primary_model_override: null,
    claude_compact_model_override: null,
    claude_model_map: null,
    compact_upstream_mode: null,
    claude_compact_upstream_mode: null,
    primary_upstream_protocol: null,
    compact_upstream_protocol: null,
    claude_primary_upstream_protocol: null,
    claude_compact_upstream_protocol: null,
    stored_api_key_count: 0
  };
}
