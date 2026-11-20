import { Readable, type Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { createCodexResponseTransform } from "../src/server/oauth-response.js";
import { createAnthropicPassthroughResponseTransform, createChatToResponsesStream } from "../src/server/protocol-stream.js";
import { sseDataFrames } from "../src/server/sse-frames.js";

async function collect(stream: Duplex, chunks: Buffer[]): Promise<string> {
  Readable.from(chunks).pipe(stream);
  const output: Buffer[] = [];
  for await (const chunk of stream) output.push(Buffer.from(chunk));
  return Buffer.concat(output).toString("utf8");
}

const headers = { "content-type": "text/event-stream" };
describe("incremental protocol SSE framing", () => {
  it.each(["native", "codex"])("accepts an exact frame budget with a fragmented delimiter: %s", async kind => {
    const event = kind === "native" ? { type: "message_stop", padding: "" } : {
      type: "response.completed", response: { id: "synthetic", status: "completed", output: [] }, padding: ""
    };
    event.padding = "x".repeat(32 * 1024 * 1024 - Buffer.byteLength(`data: ${JSON.stringify(event)}`));
    const frame = Buffer.from(`data: ${JSON.stringify(event)}`);
    const stream = kind === "native" ? createAnthropicPassthroughResponseTransform(200, headers)!.stream
      : createCodexResponseTransform(200, headers, false)!.stream;
    const output = await collect(stream, [frame, Buffer.from("\r"), Buffer.from("\n"), Buffer.from("\r"), Buffer.from("\n")]);
    if (kind === "native") expect(output === frame.toString() + "\r\n\r\n").toBe(true);
    else expect(JSON.parse(output).status).toBe("completed");
  });

  it.each(["\n\n", "\r\n\r\n", "\n\r\n", "\r\n\n", "\r\r", "\n\r", "\r\n\r", "\r\r\n"])("preserves Unicode, multiline data and terminal frames with %j", async separator => {
    const data = JSON.stringify({ id: "synthetic", model: "synthetic", choices: [{ index: 0, delta: { content: "中文🙂" }, finish_reason: null }] }, null, 2);
    const source = Buffer.from(": heartbeat" + separator + data.split("\n").map(line => "data: " + line).join(separator === "\r\r" ? "\r" : "\r\n") + separator + "data: [DONE]");
    const output = await collect(createChatToResponsesStream(), [...source].map(byte => Buffer.from([byte])));
    expect(output).toContain("中文🙂");
    expect(output).toContain("response.completed");
    expect(output).not.toContain("response.failed");
  });

  it("keeps native passthrough bytes and errors unchanged, including an unseparated tail", async () => {
    const source = Buffer.from(": heartbeat\r\n\r\ndata: {\"type\":\"error\",\"error\":{\"message\":\"synthetic\"}}\r");
    expect(await collect(createAnthropicPassthroughResponseTransform(200, headers)!.stream, [...source].map(byte => Buffer.from([byte])))).toBe(source.toString());
  });

  it.each(["", "\n", "\r", "\r\n", "\r\n\r", "\n\n", "\r\n\r\n", "\r\r", "\n\r"])("delimits native EOF repairs after %j", async ending => {
    for (const kind of ["text", "tool_use"]) {
      const open = { type: "content_block_start", index: 0, content_block: { type: kind } };
      const delta = kind === "text" ? { type: "text_delta", text: "末段" } : { type: "input_json_delta", partial_json: "{" };
      const last = { type: "content_block_delta", index: 0, delta };
      const original = [{ type: "message_start", message: {} }, open, last];
      const source = original.map(event => "data: " + JSON.stringify(event)).join("\r\n\r\n") + ending;
      const wire = await collect(createAnthropicPassthroughResponseTransform(200, headers)!.stream,
        [...Buffer.from(source)].map(byte => Buffer.from([byte])));
      expect(wire.startsWith(source)).toBe(true);
      const events = sseDataFrames(wire).map(data => JSON.parse(data));
      expect(events.slice(0, 3)).toEqual(original);
      expect(events.slice(3).map(event => event.type)).toEqual(
        kind === "text" ? ["content_block_stop", "message_delta", "message_stop"] : ["error"]);
    }
  });
});
