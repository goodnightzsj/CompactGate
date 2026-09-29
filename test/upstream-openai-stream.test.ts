import { describe, expect, it } from "vitest";
import { createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { extractResponseModelFromText } from "../src/server/response-model.js";

describe("OpenAI stream observer", () => {
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
