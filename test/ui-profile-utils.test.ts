import { describe, expect, it } from "vitest";
import { nextUniqueProfileName } from "../src/ui/config/profile-utils.js";

describe("nextUniqueProfileName", () => {
  it("returns the base name when it is free", () => {
    expect(nextUniqueProfileName("live", ["prod", "staging"])).toBe("live");
  });

  it("appends a counter when the base name is taken", () => {
    expect(nextUniqueProfileName("live", ["live", "prod"])).toBe("live 2");
  });

  it("keeps counting until it finds a free name", () => {
    expect(nextUniqueProfileName("live", ["live", "live 2", "live 3"])).toBe("live 4");
  });
});
