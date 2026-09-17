import { describe, expect, it, vi } from "vitest";
import { ClaudeKeyPoolState } from "../src/server/claude-key-pool.js";
import * as upstreamClient from "../src/server/upstream-client.js";
import { startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

it.each(["agentrouter.org", "anyrouter.top"])("does not record upstream success for local counting on %s", async (host) => {
  const outbound = vi.spyOn(upstreamClient, "sendBufferedUpstreamRequest")
    .mockRejectedValue(new Error("External requests are forbidden in this test."));
  const results = vi.spyOn(ClaudeKeyPoolState.prototype, "recordResult");
  try {
    const app = await startApp(undefined, undefined, { claude: { primary: {
      base_url: `https://${host}`, api_key: "", api_key_env: "",
      api_keys: [
        { id: "k1", label: "One", api_key: "synthetic-1", enabled: true },
        { id: "k2", label: "Two", api_key: "synthetic-2", enabled: true }
      ]
    } } });
    const response = await fetch(`${app.url}/anthropic/v1/messages/count_tokens`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "synthetic" }] })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-short-circuit")).toBe("local-count-tokens");
    await response.json();
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log.upstream_status).toBeNull();
    expect(outbound).not.toHaveBeenCalled();
    expect(results).toHaveBeenCalledWith(expect.objectContaining({ keyId: "k1" }), null);
  } finally { outbound.mockRestore(); results.mockRestore(); }
});

describe.each([false, true])("Claude stream results reach key scheduling (profile=%s)", (withProfile) => {
  it.each(["error", "incomplete", "cancel"] as const)("attributes %s without changing the delivered HTTP status", async (mode) => {
    const keys: string[] = [];
    const upstream = await startUpstream(async (req, res) => {
      for await (const _chunk of req) { /* Consume the synthetic request. */ }
      keys.push(String(req.headers["x-api-key"]));
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "error") {
        res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Synthetic overload"}}\n\n');
      } else {
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","type":"message","role":"assistant","model":"claude-test","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
        if (mode === "incomplete") res.end();
        else req.on("close", () => res.destroy());
      }
    });
    const app = await startApp(undefined, undefined, { claude: { primary: {
      base_url: upstream.url, api_key: "", upstream_protocol: "anthropic_messages",
      api_keys: [
        { id: "k1", label: "One", api_key: "synthetic-1", enabled: true },
        { id: "k2", label: "Two", api_key: "synthetic-2", enabled: true }
      ]
    } } });
    if (withProfile) {
      const saved = await app.config.saveProfile("claude", "Pool", {});
      const profile = saved.profile_scopes!.claude!.profiles!.find((item) => item.name === "Pool")!;
      await app.config.applyProfile("claude", profile.id);
    }
    for (let index = 0; index < 4; index++) {
      const controller = new AbortController();
      const response = await fetch(`${app.url}/anthropic/v1/messages`, {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", "x-session-id": "synthetic-session" },
        body: JSON.stringify({ model: "claude-test", stream: true, messages: [{ role: "user", content: "synthetic" }] })
      });
      expect(response.status).toBe(200);
      if (mode === "cancel") {
        const reader = response.body!.getReader();
        await reader.read();
        controller.abort();
        await reader.cancel().catch(() => {});
      } else await response.text();
      const requestId = response.headers.get("x-compactgate-request-id");
      const log = await waitForLogEntry(app.url, (entry) => entry.request_id === requestId);
      expect(log.key_name).toBe(index === 3 && mode !== "cancel" ? "Two" : "One");
      expect(log.stream_outcome).toBe(mode === "cancel" ? "client_cancel"
        : mode === "error" ? "upstream_stream_error" : "upstream_stream_incomplete");
    }
    expect(keys).toEqual(["synthetic-1", "synthetic-1", "synthetic-1", mode === "cancel" ? "synthetic-1" : "synthetic-2"]);
  });
});
