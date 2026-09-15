import { describe, expect, it } from "vitest";
import { selectMenuPlacement } from "../src/ui/shared/CustomSelect.js";

describe("select menu anchoring", () => {
  it("anchors short upward menus by their bottom edge rather than a 320px assumed height", () => {
    const style = selectMenuPlacement({ top: 600, bottom: 656, left: 30, width: 300 }, { width: 800, height: 700 }, 128);
    expect(style).toMatchObject({ bottom: 108, width: 300, maxHeight: 320 });
    expect(style).not.toHaveProperty("top");
    expect(700 - Number(style.bottom)).toBe(600 - 8);
  });

  it("prefers below whenever the content fits even if there is more room above", () => {
    expect(selectMenuPlacement({ top: 500, bottom: 550, left: 30, width: 300 }, { width: 800, height: 800 }, 128))
      .toMatchObject({ top: 558, maxHeight: 230 });
  });

  it("constrains wide menus and tall content to small viewports without a 120px minimum overflow", () => {
    const style = selectMenuPlacement({ top: 70, bottom: 114, left: 180, width: 280 }, { width: 320, height: 180 }, 400, true);
    expect(style).toMatchObject({ left: 12, width: 296, maxHeight: 50, bottom: 118 });
  });
});
