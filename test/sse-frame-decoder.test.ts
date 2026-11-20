import { describe, expect, it } from "vitest";
import { createSseFrameDecoder } from "../src/server/sse-frames.js";

describe("SSE frame decoder", () => {
  it.each(["\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n", "\r\r", "\n\r", "\r\n\r", "\r\r\n"])("matches whole-buffer framing at every split with %j", separator => {
    const frames = [": heartbeat", "data: 中文🙂\r\ndata: second", "data: final\r"];
    const source = Buffer.from(frames.join(separator));
    for (let split = 0; split <= source.length; split++) {
      const received: string[] = [];
      const decoder = createSseFrameDecoder(frame => received.push(frame));
      decoder.write(source.subarray(0, split));
      decoder.write(source.subarray(split));
      decoder.end();
      expect(received).toEqual(frames);
    }
  });

  it.each(["", "\r", "\n", "\r\n"])("counts an unseparated final tail in the frame budget: %j", tail => {
    const received: string[] = [];
    const decoder = createSseFrameDecoder(frame => received.push(frame), bytes => {
      if (bytes > 16) throw new Error("synthetic budget");
    });
    decoder.write(Buffer.from("x".repeat(16) + tail));
    if (tail) expect(() => decoder.end()).toThrow("synthetic budget");
    else { decoder.end(); expect(received).toEqual(["x".repeat(16)]); }
  });

  it.each(["\r\n\r\n", "\r\r", "\n\n", "\n\r"])("resets a per-frame budget, excluding partial delimiters but rejecting real overflow (%j)", separator => {
    const received: string[] = [];
    const decoder = createSseFrameDecoder(frame => received.push(frame), bytes => {
      if (bytes > 16) throw new Error("synthetic budget");
    });
    for (let frame = 0; frame < 2; frame++) {
      decoder.write(Buffer.from("x".repeat(16)));
      for (const byte of separator) decoder.write(Buffer.from(byte));
    }
    expect(received).toEqual(["x".repeat(16), "x".repeat(16)]);
    decoder.write(Buffer.from("x".repeat(16) + "\r"));
    expect(() => decoder.write(Buffer.from("y"))).toThrow("synthetic budget");
  });
});
