import { describe, expect, it } from "vitest";
import {
  buildClaudeLaunch,
  buildCodexLaunch,
  parseAgentCommand
} from "../src/server/agent-launcher.js";

describe("agent launcher", () => {
  it("builds a process-local Codex Responses provider and preserves arguments", () => {
    const plan = buildCodexLaunch({
      serverUrl: "http://127.0.0.1:8123/",
      profileId: "codex-profile",
      env: { PATH: "/bin" },
      args: ["--model", "gpt-5.5", "prompt"]
    });

    expect(plan.command).toBe("codex");
    expect(plan.args.slice(-3)).toEqual(["--model", "gpt-5.5", "prompt"]);
    expect(plan.args).toContain('model_provider = "compactgate"');
    const provider = plan.args[3] ?? "";
    expect(provider).toContain('name = "OpenAI"');
    expect(provider).toContain('base_url = "http://127.0.0.1:8123/v1"');
    expect(provider).toContain('wire_api = "responses"');
    expect(provider).toContain("requires_openai_auth = false");
    expect(provider).toContain('"x-compactgate-profile" = "codex-profile"');
    expect(plan.env).toEqual({ PATH: "/bin" });
  });

  it("builds Claude settings JSON without writing user settings", () => {
    const plan = buildClaudeLaunch({
      serverUrl: "http://127.0.0.1:8123/v1",
      profileId: "claude-profile",
      env: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: "old-key",
        ANTHROPIC_AUTH_TOKEN: "old-token",
        ANTHROPIC_BASE_URL: "https://old.example",
        ANTHROPIC_CUSTOM_HEADERS: "x-old: value"
      },
      args: ["--print", "hello"]
    });

    expect(plan.command).toBe("claude");
    expect(plan.args.slice(-2)).toEqual(["--print", "hello"]);
    const settings = JSON.parse(plan.args[1] ?? "{}") as { env?: Record<string, string> };
    expect(settings.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8123/anthropic",
      ANTHROPIC_AUTH_TOKEN: "compactgate-local",
      ANTHROPIC_CUSTOM_HEADERS: "x-compactgate-profile: claude-profile"
    });
    expect(plan.env).toEqual({ PATH: "/bin" });
  });

  it("parses launcher options and keeps the agent argument tail intact", () => {
    expect(parseAgentCommand([
      "codex",
      "--url=http://127.0.0.1:8123",
      "--profile",
      "profile-id",
      "--",
      "--profile",
      "agent-profile",
      "prompt"
    ])).toEqual({
      kind: "codex",
      options: {
        serverUrl: "http://127.0.0.1:8123",
        profileId: "profile-id"
      },
      args: ["--profile", "agent-profile", "prompt"]
    });
  });

  it("rejects flags missing a value and leaves lookalike flags as agent arguments", () => {
    expect(() => parseAgentCommand(["codex", "--url"])).toThrow("--url requires a value.");
    expect(() => parseAgentCommand(["codex", "--url="])).toThrow("--url requires a value.");
    expect(() => parseAgentCommand(["codex", "--profile"])).toThrow("--profile requires a value.");
    expect(() => parseAgentCommand(["codex", "--profile="])).toThrow("--profile requires a value.");
    // "=" inside the value survives; lookalikes and short flags stay positional.
    expect(parseAgentCommand(["codex", "--url=http://a?x=y"]).options.serverUrl)
      .toBe("http://a?x=y");
    expect(parseAgentCommand(["codex", "--urlfoo", "-m", "gpt"]).args)
      .toEqual(["--urlfoo", "-m", "gpt"]);
    expect(parseAgentCommand(["codex", "--url", "http://a", "-m", "gpt"]))
      .toEqual({
        kind: "codex",
        options: { serverUrl: "http://a", profileId: undefined },
        args: ["-m", "gpt"]
      });
  });

  it("rejects profile IDs that could inject another header", () => {
    expect(() => buildClaudeLaunch({
      profileId: "profile\r\nx-injected: true"
    })).toThrow("not a valid HTTP header value");
  });
});
