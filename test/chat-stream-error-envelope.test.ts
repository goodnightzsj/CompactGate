import { describe, expect, it } from "vitest";
import { createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

const error = { message: "Synthetic Chat quota failure.", type: "insufficient_quota", code: "insufficient_quota" };
const variants = ["bare_error", "typed_error", "json_error", "ordinary_success"] as const;
function wire(variant: typeof variants[number]): string {
  if (variant === "json_error") return JSON.stringify({ error });
  const record = variant === "ordinary_success"
    ? { id: "chatcmpl_synthetic", model: "synthetic", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }] }
    : { ...(variant === "typed_error" ? { type: "error" } : {}), error };
  return `data: ${JSON.stringify(record)}\n\ndata: [DONE]\n\n`;
}

describe("Chat stream error envelopes at the source observer", () => {
  it.each(["bare_error", "typed_error", "ordinary_success"] as const)("classifies %s", async variant => {
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" })!;
    observer.observe(Buffer.from(wire(variant)));
    const result = await observer.finish();
    expect(result.sawFailedEvent).toBe(variant !== "ordinary_success");
    expect(result.sawDoneMarker).toBe(true);
    if (variant !== "ordinary_success") {
      expect(result.errorSummary).toContain(error.message);
      expect(result.terminalEvent).toBe("error");
    } else {
      expect(result.errorSummary).toBeNull();
      expect(result.terminalEvent).toBe("[DONE]");
    }
  });

  it("does not treat an error key inside model output or metadata as a protocol failure", async () => {
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" })!;
    observer.observe(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ error }) } }], metadata: { error } })}\n\ndata: [DONE]\n\n`));
    expect(await observer.finish()).toMatchObject({ sawFailedEvent: false, errorSummary: null, terminalEvent: "[DONE]" });
  });

  it.each(variants)("native Chat HTTP accounts for %s", async variant => {
    let calls = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      calls++;
      res.writeHead(200, { "content-type": variant === "json_error" ? "application/json" : "text/event-stream" });
      res.end(wire(variant));
    });
    const app = await startApp(upstream.url, undefined, { primary: { upstream_protocol: "openai_chat" } });
    const response = await postJson(app.url, "/v1/chat/completions", {
      model: "synthetic", messages: [{ role: "user", content: "Hello" }], stream: variant !== "json_error"
    });
    expect(await response.text()).toBe(wire(variant));
    expect(calls).toBe(1);
    const log = await waitForLogEntry(app.url, item => item.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log.stream_outcome === "success").toBe(variant === "ordinary_success");
    if (variant !== "ordinary_success") expect(log.error_summary).toContain(error.message);
  });

  it("translated Responses client already treats the bare Chat error as failure", async () => {
    const upstream = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(wire("bare_error"));
    });
    const app = await startApp(upstream.url, undefined, { primary: { upstream_protocol: "openai_chat" } });
    const response = await postJson(app.url, "/v1/responses", { model: "synthetic", input: "Hello", stream: true });
    expect(await response.text()).toContain("response.failed");
    const log = await waitForLogEntry(app.url, item => item.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log.stream_outcome).not.toBe("success");
    expect(log.error_summary).toContain(error.message);
  });
});
