import { describe, expect, it } from "vitest";
import { isLatestPreviewRequest } from "../src/ui/hooks/useRoutePreviewAction.js";

describe("route preview request ordering", () => {
  it("accepts only the latest preview response", () => {
    expect(isLatestPreviewRequest(2, 2)).toBe(true);
    expect(isLatestPreviewRequest(1, 2)).toBe(false);
  });
});
