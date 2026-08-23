import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigSaveBar } from "../src/ui/config/ConfigSaveBar.js";
import { ConfigSaveAsNewProfileDialog } from "../src/ui/config/ConfigSaveAsNewProfileDialog.js";
import type { PublicConfig } from "../src/shared/types.js";

describe("ConfigSaveBar", () => {
  it("disables saving when the configuration is unchanged", () => {
    const markup = renderSaveBar(false);

    expect(saveButtonTag(markup)).toContain("disabled");
  });

  it("enables saving when the configuration has pending changes", () => {
    const markup = renderSaveBar(true);

    expect(saveButtonTag(markup)).not.toContain("disabled");
  });

  it("offers saving the current draft as a new profile", () => {
    const markup = renderSaveBar(true);

    expect(markup).toContain("另存为新档案");
  });

  it("locks a reviewed cross-scope creation to its target and shows the route preview", () => {
    const markup = renderToStaticMarkup(
      <ConfigSaveAsNewProfileDialog
        config={profileConfig("claude", "Existing")}
        initialName="Codex A"
        initialScope="claude"
        scopeLocked
        title="创建为 Claude 档案"
        description="保留上游协议"
        submitLabel="创建 Claude 档案"
        onCancel={() => undefined}
        onConfirm={() => Promise.resolve(true)}
      >
        <div aria-label="待创建档案路由预览">OpenAI Responses</div>
      </ConfigSaveAsNewProfileDialog>
    );

    expect(markup).toContain("创建为 Claude 档案");
    expect(markup).toContain('value="Codex A"');
    expect(markup).toContain('aria-label="目标档案作用域"');
    expect(markup).toContain("OpenAI Responses");
    expect(markup).not.toContain('role="radiogroup"');
  });

  it("rejects a duplicate name in the locked target scope", () => {
    const markup = renderToStaticMarkup(
      <ConfigSaveAsNewProfileDialog
        config={profileConfig("claude", "Existing")}
        initialName="Existing"
        initialScope="claude"
        scopeLocked
        onCancel={() => undefined}
        onConfirm={() => Promise.resolve(true)}
      />
    );

    expect(markup).toContain("Claude 已有同名档案");
    expect(markup.match(/<button[^>]*disabled=""[^>]*>保存为新档案<\/button>/)).not.toBeNull();
  });
});

function renderSaveBar(hasPendingChanges: boolean): string {
  return renderToStaticMarkup(
    <ConfigSaveBar
      config={null}
      saveState="idle"
      saveError={null}
      saveConflict={false}
      hasPendingChanges={hasPendingChanges}
      profileErrors={{ codex: null, claude: null }}
      onSaveConfig={() => undefined}
      onOverrideSaveConflict={() => undefined}
      onSaveProfileAsNew={() => Promise.resolve(true)}
    />
  );
}

function saveButtonTag(markup: string): string {
  return markup.match(/<button[^>]*>/)?.[0] ?? "";
}

function profileConfig(scope: "codex" | "claude", name: string): PublicConfig {
  return {
    profile_scopes: {
      codex: { profiles: [], active_profile_id: null },
      claude: { profiles: [], active_profile_id: null },
      [scope]: {
        profiles: [{ id: "existing", name }],
        active_profile_id: null
      }
    }
  } as unknown as PublicConfig;
}
