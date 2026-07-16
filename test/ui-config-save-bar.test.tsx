import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfigSaveBar } from "../src/ui/config/ConfigSaveBar.js";

describe("ConfigSaveBar", () => {
  it("disables saving when the configuration is unchanged", () => {
    const markup = renderSaveBar(false);

    expect(saveButtonTag(markup)).toContain("disabled");
  });

  it("enables saving when the configuration has pending changes", () => {
    const markup = renderSaveBar(true);

    expect(saveButtonTag(markup)).not.toContain("disabled");
  });
});

function renderSaveBar(hasPendingChanges: boolean): string {
  return renderToStaticMarkup(
    <ConfigSaveBar
      config={null}
      saveState="idle"
      saveError={null}
      hasPendingChanges={hasPendingChanges}
      onSaveConfig={() => undefined}
    />
  );
}

function saveButtonTag(markup: string): string {
  return markup.match(/<button[^>]*>/)?.[0] ?? "";
}
