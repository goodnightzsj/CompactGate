import { describe, expect, it } from "vitest";
import { createAnthropicStreamObserver, createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { extractResponseModelFromText } from "../src/server/response-model.js";

describe("OpenAI stream observer", () => {
  it.each(["named", "typed", "oversized"])("retains %s errors after a DONE marker", async variant => {
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { maxEventBytes: variant === "oversized" ? 128 : 1024 })!;
    const event = { type: "error", code: "server_error", message: "synthetic failure" + (variant === "oversized" ? "x".repeat(256) : "") };
    observer.observe(Buffer.from(`${variant === "typed" ? "" : "event: error\n"}data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`));
    const summary = await observer.finish();
    expect(summary).toMatchObject({ sawFailedEvent: true, sawDoneMarker: true, generationSample: null });
    if (variant !== "oversized") expect(summary.errorSummary).toContain("synthetic failure");
  });

  it.each(["\n", "\r\n", "\r"])("preserves UTF-8, event budgets and following events across byte splits with %j", async newline => {
    for (const create of [createOpenAiStreamObserver, createAnthropicStreamObserver]) {
      const terminal = create === createOpenAiStreamObserver ? "response.completed" : "message_stop";
      const lines = [`event: ${terminal}`, `data: ${JSON.stringify({ type: terminal, model: "模型😀", usage: { output_tokens: 7 } })}`];
      const body = Buffer.from(lines.join(newline) + newline + newline);
      const budget = Buffer.byteLength(lines.join(""));
      for (const chunkSize of [1, 7, body.length]) {
        for (const extra of [0, -1]) {
          const events: string[] = [];
          const observer = create({ "content-type": "text/event-stream" }, {
            maxEventBytes: budget + extra, onEvent: (_name, _record, data) => events.push(data)
          })!;
          for (let offset = 0; offset < body.length; offset += chunkSize) observer.observe(body.subarray(offset, offset + chunkSize));
          const summary = observer.snapshot();
          expect(summary).toMatchObject({ sawCompletedEvent: true, oversizedEventCount: extra === 0 ? 0 : 1 });
          expect(summary.usage?.outputTokens ?? null).toBe(extra === 0 ? 7 : null);
          expect(extractResponseModelFromText(body.toString())).toBe("模型😀");
          expect(events[0]).toBe(extra === 0 ? lines[1].slice(6) : "");
          const following = 'data: {"usage":{"output_tokens":9}}';
          for (const byte of Buffer.from(following)) observer.observe(Buffer.from([byte]));
          expect((await observer.finish()).usage?.outputTokens).toBe(9);
          expect(events.at(-1)).toBe(following.slice(6));
        }
      }
    }
  });

  it.each([
    ["completed overrides initial", [["response.created", "alias"], ["response.completed", "actual"]], "actual"],
    ["last declaration without completion", [["response.created", "alias"], ["response.failed", "actual"]], "actual"],
    ["missing declaration preserves prior", [["response.created", "alias"], ["response.completed", null]], "alias"],
    ["completed declaration wins over later metadata", [["response.completed", "actual"], ["response.created", "late"]], "actual"],
    ["missing models remain unknown", [["response.created", null], ["response.completed", null]], null]
  ] as const)("uses the same model as the full response: %s", async (_name, events, expected) => {
    const body = events.map(([type, model]) => `event: ${type}\ndata: ${JSON.stringify({ type, response: { model } })}\n\n`).join("");
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" })!;
    // Exercise chunk boundaries as well as event boundaries.
    for (let offset = 0; offset < body.length; offset += 7) observer.observe(Buffer.from(body.slice(offset, offset + 7)));
    expect((await observer.finish()).responseModel).toBe(expected);
    expect(extractResponseModelFromText(body)).toBe(expected);
  });

  it("keeps an observed model when the completed payload exceeds the observation limit", async () => {
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" }, { maxEventBytes: 128 })!;
    observer.observe(Buffer.from('data: {"model":"observed"}\n\nevent: response.completed\ndata: ' + JSON.stringify({ response: { model: "unobserved", output: "x".repeat(256) } }) + "\n\n"));
    expect(await observer.finish()).toMatchObject({ responseModel: "observed", sawCompletedEvent: true, oversizedEventCount: 1 });
  });

  it("retains a named terminal event when its payload exceeds the observation limit", async () => {
    const observer = createOpenAiStreamObserver(
      { "content-type": "text/event-stream" },
      { maxEventBytes: 64 }
    );
    const frame = [
      "event: response.completed",
      `data: {"type":"response.completed","response":{"output":"${"x".repeat(256)}"}}`,
      "",
      ""
    ].join("\n");

    observer?.observe(Buffer.from(frame));

    expect(observer?.snapshot()).toMatchObject({
      eventCount: 1,
      oversizedEventCount: 1,
      sawCompletedEvent: true,
      sawTerminalEvent: true,
      terminalEvent: "response.completed"
    });
    expect(await observer?.finish()).toMatchObject({
      eventCount: 1,
      oversizedEventCount: 1
    });
  });

  it("does not expose an oversized terminal event before its frame boundary", () => {
    const observer = createOpenAiStreamObserver(
      { "content-type": "text/event-stream" },
      { maxEventBytes: 64 }
    );
    observer?.observe(Buffer.from(
      `event: response.completed\ndata: ${"x".repeat(256)}\n`
    ));

    expect(observer?.snapshot()).toMatchObject({
      eventCount: 0,
      oversizedEventCount: 1,
      sawTerminalEvent: false,
      terminalEvent: null
    });
  });

  it("keeps oversized unnamed events non-terminal", async () => {
    const observer = createOpenAiStreamObserver(
      { "content-type": "text/event-stream" },
      { maxEventBytes: 64 }
    );
    observer?.observe(Buffer.from(`data: ${"x".repeat(256)}\n\n`));

    expect(await observer?.finish()).toMatchObject({
      eventCount: 0,
      oversizedEventCount: 1,
      sawTerminalEvent: false,
      terminalEvent: null
    });
  });
});
