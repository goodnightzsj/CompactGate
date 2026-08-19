import { describe, expect, it } from "vitest";
import { applyHostQuirks, resolveHostShortCircuit } from "../src/server/host-quirks.js";

describe("applyHostQuirks", () => {
  it("adds the 1m context beta for opus targets on anyrouter", () => {
    const headers: Record<string, string> = {};
    const applied = applyHostQuirks({
      host: "anyrouter.top",
      sourceModel: "claude-haiku-4-5-20251001",
      targetModel: "claude-opus-5",
      headers
    });
    expect(applied).toEqual(["anyrouter-context-1m"]);
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
  });

  it("keeps existing beta tokens and stays idempotent", () => {
    const headers: Record<string, string> = { "anthropic-beta": "compact-2026-01-12,context-1m-2025-08-07" };
    applyHostQuirks({ host: "api.anyrouter.top", sourceModel: null, targetModel: "claude-opus-5", headers });
    expect(headers["anthropic-beta"]).toBe("compact-2026-01-12,context-1m-2025-08-07");
  });

  it("leaves other hosts untouched", () => {
    const other: Record<string, string> = {};
    applyHostQuirks({ host: "agentrouter.org", sourceModel: null, targetModel: "claude-opus-5", headers: other });
    expect(other["anthropic-beta"]).toBeUndefined();
  });

  it("adds the beta for non-opus targets too", () => {
    const headers: Record<string, string> = {};
    applyHostQuirks({ host: "anyrouter.top", sourceModel: null, targetModel: "claude-sonnet-4-5", headers });
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07");
  });

  it("drops the codex responses-lite hint on muyuan", () => {
    const headers: Record<string, string> = {
      "x-openai-internal-codex-responses-lite": "true",
      "authorization": "Bearer k"
    };
    const applied = applyHostQuirks({
      host: "muyuan.do",
      sourceModel: "gpt-5.6-sol",
      targetModel: "gpt-5.5",
      headers
    });
    expect(applied).toEqual(["muyuan-drop-codex-responses-lite"]);
    expect(headers).toEqual({ authorization: "Bearer k" });
  });

  it("keeps the responses-lite hint on other hosts", () => {
    const headers: Record<string, string> = { "x-openai-internal-codex-responses-lite": "true" };
    applyHostQuirks({ host: "anyrouter.top", sourceModel: null, targetModel: "gpt-5.6-sol", headers });
    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
  });

  it("does not match a lookalike host suffix", () => {
    const headers: Record<string, string> = {};
    applyHostQuirks({ host: "notanyrouter.top", sourceModel: null, targetModel: "claude-opus-5", headers });
    expect(headers["anthropic-beta"]).toBeUndefined();
  });
});

describe("resolveHostShortCircuit", () => {
  const body = Buffer.from(JSON.stringify({
    model: "claude-opus-4-8",
    system: "a".repeat(400),
    messages: [{ role: "user", content: "b".repeat(400) }]
  }));

  it("answers count_tokens locally for agentrouter", () => {
    const result = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: body
    });
    expect(result?.id).toBe("local-count-tokens");
    // 800 non-CJK characters at 3.5 chars/token.
    expect(JSON.parse(result!.body.toString()).input_tokens).toBe(229);
  });

  it("counts CJK text denser than latin text", () => {
    const cjk = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "中".repeat(700) }] }))
    });
    // 700 CJK characters at 2 chars/token.
    expect(JSON.parse(cjk!.body.toString()).input_tokens).toBe(350);

    const latin = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "a".repeat(700) }] }))
    });
    expect(JSON.parse(latin!.body.toString()).input_tokens).toBe(200);
  });

  it("ignores base64 image payloads", () => {
    const result = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: Buffer.from(JSON.stringify({
        messages: [{
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(10000) } }]
        }]
      }))
    });
    expect(JSON.parse(result!.body.toString()).input_tokens).toBe(0);
  });

  it("leaves normal messages requests alone", () => {
    expect(resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/v1/messages",
      rawBody: body
    })).toBeNull();
  });

  it("also answers count_tokens locally for anyrouter", () => {
    expect(resolveHostShortCircuit({
      host: "anyrouter.top",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: body
    })?.id).toBe("local-count-tokens");
  });

  it("leaves hosts that support the endpoint alone", () => {
    expect(resolveHostShortCircuit({
      host: "opencode.9962510.xyz",
      upstreamPath: "/v1/messages/count_tokens",
      rawBody: body
    })).toBeNull();
  });

  it("returns zero tokens for an unparsable body", () => {
    const result = resolveHostShortCircuit({
      host: "agentrouter.org",
      upstreamPath: "/messages/count_tokens",
      rawBody: Buffer.from("not json")
    });
    expect(JSON.parse(result!.body.toString())).toEqual({ input_tokens: 0 });
  });
});
