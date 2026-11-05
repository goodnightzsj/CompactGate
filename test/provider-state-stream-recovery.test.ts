import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { captureRequest, startApp, startUpstream, JSON_HEADERS } from "./helpers/server-test-utils.js";

const frame = (type: string, rest: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
const failed = frame("response.failed", { response: { status: "failed", output: [], error: { code: "invalid_encrypted_content", message: "Encrypted content could not be decrypted or parsed." } } });
const completed = frame("response.completed", { response: { id: "resp_fixture", status: "completed", output: [] } });
const input = [{ type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "sealed-fixture" }, { role: "user", content: "continue" }];

describe("early Responses SSE state rejection", () => {
  it.each(["identity", "gzip"])("recovers a %s stream before any output", async encoding => {
    const sent: unknown[][] = [];
    const upstream = await startUpstream(async (req, res) => {
      sent.push(JSON.parse((await captureRequest(req)).body).input);
      const text = sent.length === 1 ? frame("response.created", { response: { output: [] } }) + failed : completed;
      res.writeHead(200, { "content-type": "text/event-stream", ...(encoding === "gzip" ? { "content-encoding": "gzip" } : {}) });
      res.end(encoding === "gzip" ? gzipSync(text) : text);
    });
    const app = await startApp(upstream.url, upstream.url);
    const response = await fetch(`${app.url}/v1/responses`, { method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ model: "gpt-fixture", store: false, stream: true, input }) });
    expect(await response.text()).toBe(completed);
    expect(sent).toEqual([input, [input[1]]]);
    expect(response.headers.get("x-compactgate-context-fidelity")).toBe("degraded");
  });

  it.each([
    frame("response.output_text.delta", { delta: "already delivered" }),
    frame("response.output_item.added", { item: { type: "function_call", call_id: "call_fixture", name: "write", arguments: "{}" } }),
    frame("response.web_search_call.in_progress"),
    frame("vendor.unknown_event")
  ])("never replays after an output, tool or unknown event", async prefix => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureRequest(req); attempts++;
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(prefix + failed);
    });
    const app = await startApp(upstream.url, upstream.url);
    const response = await fetch(`${app.url}/v1/responses`, { method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ model: "gpt-fixture", store: false, stream: true, input }) });
    expect(await response.text()).toBe(prefix + failed);
    expect(attempts).toBe(1);
  });

  it("returns the original SSE failure when there is no repair", async () => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureRequest(req); attempts++;
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(failed);
    });
    const app = await startApp(upstream.url, upstream.url);
    const response = await fetch(`${app.url}/v1/responses`, { method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ model: "gpt-fixture", store: false, stream: true, input: [input[1]] }) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(failed);
    expect(attempts).toBe(1);
  });

  it("shares the four-attempt budget across reasoning, compaction ID and opaque compaction repairs", async () => {
    const sent: Array<Array<Record<string, unknown>>> = [];
    const upstream = await startUpstream(async (req, res) => {
      const body = JSON.parse((await captureRequest(req)).body); sent.push(body.input);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(body.input.some((item: Record<string, unknown>) => item.encrypted_content) ? failed : completed);
    });
    const app = await startApp(upstream.url, upstream.url);
    const compaction = { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-compaction" };
    const response = await fetch(`${app.url}/v1/responses`, { method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ model: "gpt-fixture", store: false, stream: true, input: [compaction, ...input] }) });
    expect(await response.text()).toBe(completed);
    expect(sent).toEqual([[compaction, ...input], [compaction, input[1]],
      [{ type: "compaction", encrypted_content: "opaque-compaction" }, input[1]], [input[1]]]);
    expect(response.headers.get("x-compactgate-context-fidelity")).toBe("degraded");
  });

  it("does not replay a buffered state failure after client cancellation", async () => {
    let attempts = 0;
    let arrived!: () => void;
    let closed!: () => void;
    const received = new Promise<void>(resolve => { arrived = resolve; });
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve; });
    const upstream = await startUpstream(async (req, res) => {
      await captureRequest(req); attempts++;
      res.on("close", closed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(failed, arrived);
    });
    const app = await startApp(upstream.url, upstream.url);
    const abort = new AbortController();
    const request = fetch(`${app.url}/v1/responses`, { method: "POST", headers: JSON_HEADERS, signal: abort.signal,
      body: JSON.stringify({ model: "gpt-fixture", store: false, stream: true, input }) });
    const cancelled = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await received; abort.abort();
    await cancelled; await upstreamClosed;
    expect(attempts).toBe(1);
  });
});
