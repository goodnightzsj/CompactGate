import { describe, expect, it } from "vitest";
import { createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";

describe("OpenAI stream observer", () => {
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
