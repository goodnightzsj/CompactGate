import { describe, expect, it } from "vitest";
import {
  CodexVersionMonitor,
  effectiveCodexProtocol,
  parseCodexClientUserAgent,
  parseCodexVersionOutput
} from "../src/server/codex-version.js";

describe("Codex version parsing", () => {
  it("preserves a fork version while extracting its official baseline", () => {
    expect(parseCodexClientUserAgent(
      "codex-tui/0.144.1-cometix (Mac OS 15.0.1; arm64) iTerm.app/3.6.11"
    )).toEqual({
      name: "codex-tui",
      raw_version: "0.144.1-cometix",
      base_version: "0.144.1",
      variant: "cometix",
      is_fork: true
    });
  });

  it("parses the local CLI version output", () => {
    expect(parseCodexVersionOutput("codex-cli 0.144.6\n")).toEqual({
      name: "codex-cli",
      raw_version: "0.144.6",
      base_version: "0.144.6",
      variant: null,
      is_fork: false
    });
  });

  it("uses 0.140.0 as the V2 default boundary", () => {
    expect(effectiveCodexProtocol("0.139.9")).toBe("remote_v1");
    expect(effectiveCodexProtocol("0.140.0")).toBe("remote_v2");
    expect(effectiveCodexProtocol("0.144.1")).toBe("remote_v2");
  });
});

describe("CodexVersionMonitor", () => {
  it("prefers observed fork behavior over the installed version inference", () => {
    const monitor = new CodexVersionMonitor({
      probe: () => "codex-cli 0.139.0",
      now: () => new Date("2026-07-19T00:00:00.000Z")
    });
    monitor.start();

    try {
      expect(monitor.snapshot([
        {
          time: "2026-07-19T00:01:00.000Z",
          user_agent: "codex-tui/0.144.1-cometix (Mac OS 15.0.1; arm64)",
          compaction_mode: "remote_v2"
        }
      ])).toMatchObject({
        observed_protocol: "remote_v2",
        protocol_source: "request",
        confidence: "observed",
        local_client: { raw_version: "0.139.0" },
        observed_clients: [{
          raw_version: "0.144.1-cometix",
          base_version: "0.144.1",
          variant: "cometix",
          is_fork: true,
          protocols: ["remote_v2"]
        }]
      });
    } finally {
      monitor.close();
    }
  });

  it("reports mixed when different actual remote protocols are observed", () => {
    const monitor = new CodexVersionMonitor({ probe: () => null });
    monitor.start();

    try {
      expect(monitor.snapshot([
        {
          time: "2026-07-19T00:01:00.000Z",
          user_agent: "codex-tui/0.139.0",
          compaction_mode: "remote_v1"
        },
        {
          time: "2026-07-19T00:02:00.000Z",
          user_agent: "codex-tui/0.144.1-cometix",
          compaction_mode: "remote_v2"
        }
      ])).toMatchObject({
        observed_protocol: "mixed",
        protocol_source: "request",
        confidence: "observed"
      });
    } finally {
      monitor.close();
    }
  });

  it("ignores ordinary requests while retaining compact evidence beyond the client display limit", () => {
    const monitor = new CodexVersionMonitor({ probe: () => null });
    monitor.start();

    try {
      const ordinary = Array.from({ length: 8 }, (_, index) => ({
        time: `2026-07-19T00:${String(index + 10).padStart(2, "0")}:00.000Z`,
        user_agent: `codex-tui/0.14${index}.0-fork${index}`,
        compaction_mode: null
      }));
      expect(monitor.snapshot([
        ...ordinary,
        {
          time: "2026-07-19T00:00:00.000Z",
          user_agent: "codex-tui/0.144.1-cometix",
          compaction_mode: "remote_v2"
        }
      ])).toMatchObject({
        observed_protocol: "remote_v2",
        observed_at: "2026-07-19T00:00:00.000Z",
        observed_clients: [{ raw_version: "0.144.1-cometix", protocols: ["remote_v2"] }]
      });
    } finally {
      monitor.close();
    }
  });
});
