import { describe, expect, it } from "vitest";
import { isNativeCliRequest } from "../src/server/client-identity.js";
import { parseCodexClientUserAgent } from "../src/server/codex-version.js";

describe("native CLI identity boundaries", () => {
  it.each([
    ["codex", "wrapper codex-cli/1.2.3"],
    ["codex", "codex-cli:1.2.3"],
    ["codex", "codex-cli 1.2.3"],
    ["codex", "codex-cli/1.2.3wrapper"],
    ["codex", "codex-cli/1.2.3.4"],
    ["claude", "wrapper claude-cli/2.1.234"],
    ["claude", "claude-cli/2.1.234wrapper"],
    ["claude", "claude-cli/2.1.234.4"]
  ] as const)("rejects %s wrappers and malformed agents: %s", (kind, userAgent) => {
    expect(isNativeCliRequest(kind, { "user-agent": userAgent })).toBe(false);
  });

  it.each([
    ["codex", "codex/1.2.3"],
    ["codex", "codex-cli/1.2.3"],
    ["codex", "codex_exec/1.2.3-cometix (Mac OS 15.0.1; arm64)"],
    ["codex", "codex_cli_rs/1.2.3 (Mac OS 15.0.1; arm64)"],
    ["claude", "claude-cli/2.1.234"],
    ["claude", "claude-cli/2.1.234 (external, cli)"]
  ] as const)("keeps native %s agents: %s", (kind, userAgent) => {
    expect(isNativeCliRequest(kind, { "user-agent": userAgent })).toBe(true);
  });

  it("retains permissive Codex parsing for historical request logs", () => {
    expect(parseCodexClientUserAgent("wrapper codex-cli:1.2.3")).toMatchObject({
      name: "codex-cli",
      raw_version: "1.2.3"
    });
  });
});
