import { describe, expect, it } from "vitest";
import { resolveUpstreamAgent } from "../src/server/upstream-proxy-agent.js";
import { setEnv } from "./helpers/server-test-utils.js";

function clearProxyEnvironment(): void {
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy"
  ]) {
    setEnv(key, "");
  }
}

describe("upstream proxy agent", () => {
  it("lets an explicit proxy override environment and NO_PROXY", () => {
    clearProxyEnvironment();
    setEnv("HTTPS_PROXY", "not-a-valid-proxy-url");
    setEnv("NO_PROXY", "*");

    expect(resolveUpstreamAgent(
      new URL("https://api.example.test/v1"),
      "http://127.0.0.1:8080"
    )).toBeDefined();
  });

  it("fails closed for invalid configured or environment proxies", () => {
    clearProxyEnvironment();
    expect(() => resolveUpstreamAgent(
      new URL("https://api.example.test/v1"),
      "https://127.0.0.1:8080"
    )).toThrow("must be an http URL without a path, query, or fragment");
    expect(() => resolveUpstreamAgent(
      new URL("http://api.example.test/v1"),
      "http://127.0.0.1:8080"
    )).toThrow("requires an HTTPS upstream");

    setEnv("HTTPS_PROXY", "not-a-valid-proxy-url");
    expect(() => resolveUpstreamAgent(new URL("https://api.example.test/v1"))).toThrow(
      "HTTPS proxy environment is invalid"
    );
  });
});
