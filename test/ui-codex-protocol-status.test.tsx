import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodexProtocolStatus } from "../src/ui/routes/CodexProtocolStatus.js";

describe("CodexProtocolStatus", () => {
  it("shows observed fork protocol and the V1/V2 comparison", () => {
    const markup = renderToStaticMarkup(
      <CodexProtocolStatus
        status={{
          local_client: {
            name: "codex-cli",
            raw_version: "0.144.1-cometix",
            base_version: "0.144.1",
            variant: "cometix",
            is_fork: true
          },
          local_source: "local_cli",
          last_checked_at: "2026-07-19T00:00:00.000Z",
          observed_clients: [{
            name: "codex-tui",
            raw_version: "0.144.1-cometix",
            base_version: "0.144.1",
            variant: "cometix",
            is_fork: true,
            last_observed_at: "2026-07-19T00:01:00.000Z",
            protocols: ["remote_v2"]
          }],
          observed_protocol: "remote_v2",
          observed_at: "2026-07-19T00:01:00.000Z",
          protocol_source: "request",
          confidence: "observed",
          v2_default_from: "0.140.0"
        }}
      />
    );

    expect(markup).toContain("Remote V2");
    expect(markup).toContain("实际观测");
    expect(markup).toContain("0.144.1-cometix");
    expect(markup).toContain("二开变体");
    expect(markup).toContain("/responses/compact");
    expect(markup).toContain("compaction_trigger");
  });

  it("does not attribute an unrecognized observed request to the local CLI", () => {
    const markup = renderToStaticMarkup(
      <CodexProtocolStatus
        status={{
          local_client: {
            name: "codex-cli",
            raw_version: "0.144.1-cometix",
            base_version: "0.144.1",
            variant: "cometix",
            is_fork: true
          },
          local_source: "local_cli",
          last_checked_at: "2026-07-19T00:00:00.000Z",
          observed_clients: [],
          observed_protocol: "remote_v2",
          observed_at: "2026-07-19T00:01:00.000Z",
          protocol_source: "request",
          confidence: "observed",
          v2_default_from: "0.140.0"
        }}
      />
    );

    expect(markup).toContain("未探测");
    expect(markup).not.toContain("codex-cli 0.144.1-cometix");
  });
});
