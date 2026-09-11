import type { Dispatch, SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigModelPanel } from "../src/ui/config/ConfigModelPanel.js";
import { emptyForm, renderLinkedModel } from "../src/ui/config/config-form-state.js";
import type { ConfigFormState } from "../src/ui/config/types.js";

describe("ConfigModelPanel", () => {
  it("labels the Compact model input without wrapping its action button", () => {
    const form = emptyForm();
    const setForm: Dispatch<SetStateAction<ConfigFormState>> = () => undefined;
    const markup = renderToStaticMarkup(
      <ConfigModelPanel
        config={null}
        form={form}
        linkedCompactModel={renderLinkedModel(form.primaryModelOverride, form.modelTemplate)}
        onFormChange={setForm}
        onUnlockCompactModel={() => undefined}
        onRestoreLinkedMode={() => undefined}
      />
    );

    const labelBody = markup.match(
      /<label[^>]*for="compact-model-target"[^>]*>(.*?)<\/label>/
    )?.[1];
    expect(labelBody).toBe("目标模型");
    expect(markup).toContain('<div class="compact-model-control"><input id="compact-model-target"');
    expect(markup.match(/<input id="primary-model-override"[^>]*>/)?.[0]).not.toContain("disabled");
  });

  it("shows Claude model drafts without the Codex controls", () => {
    const form = emptyForm();
    form.claudeModelMap.sonnet = "claude-draft-model";
    const markup = renderToStaticMarkup(
      <ConfigModelPanel
        config={null}
        form={form}
        scope="claude"
        linkedCompactModel="codex-compact-model"
        onFormChange={() => undefined}
        onUnlockCompactModel={() => undefined}
        onRestoreLinkedMode={() => undefined}
      />
    );

    expect(markup).toContain('value="claude-draft-model"');
    expect(markup).not.toContain('id="primary-model-override"');
    expect(markup).not.toContain('id="compact-model-target"');
  });
});
