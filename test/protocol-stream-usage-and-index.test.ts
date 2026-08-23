import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  createAnthropicToResponsesResponseTransform,
  createAnthropicToResponsesStream,
  createResponsesToAnthropicResponseTransform,
  createResponsesToAnthropicStream
} from "../src/server/protocol-stream.js";
import { createOpenAiStreamObserver } from "../src/server/upstream-openai-stream.js";
import { extractUsageFromJsonText } from "../src/server/usage-record.js";

async function pump(transform: NodeJS.ReadWriteStream, frames: Array<[string, unknown]>): Promise<string> {
  const source = Readable.from(frames.map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const chunks: Buffer[] = [];
  source.pipe(transform);
  for await (const chunk of transform) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function events(sse: string): Array<Record<string, unknown>> {
  return sse.split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter((data): data is string => Boolean(data))
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe("translated streams keep the numbers and the block positions", () => {
  it("reports the input and cache tokens a real upstream only sends at the end", async () => {
    // Every existing fixture put usage inside response.created, which real
    // upstreams leave null — the counts arrive on response.completed. message_start
    // is already on the wire by then, so message_delta is the only frame left that
    // can carry them, and it used to emit output_tokens alone. claude-proxy prefers
    // the usage observed off this translated stream, so the whole request logged
    // inputTokens: 0.
    const sse = await pump(createResponsesToAnthropicStream(), [
      ["response.created", { type: "response.created", response: { id: "resp_1", model: "m", usage: null } }],
      ["response.completed", {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "m",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 1234,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 34 }
          }
        }
      }]
    ]);

    const delta = events(sse).find((event) => event.type === "message_delta");
    expect(delta?.usage).toMatchObject({
      input_tokens: 200,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 34,
      output_tokens: 7
    });
  });

  it("keeps the cache split on the SSE path, matching the JSON path", async () => {
    const sse = await pump(createAnthropicToResponsesStream(), [
      ["message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude",
          usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }
        }
      }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
      ["message_stop", { type: "message_stop" }]
    ]);

    const completed = events(sse).find((event) => event.type === "response.completed");
    const usage = (completed?.response as Record<string, unknown>).usage;
    // Rebuilding the envelope from two scalars dropped input_tokens_details, so the
    // total was right while the cache hit rate read as zero.
    expect(usage).toMatchObject({
      input_tokens: 1050,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 900, cache_write_tokens: 50 }
    });
    expect(extractUsageFromJsonText(JSON.stringify({ usage }))).toMatchObject({
      cachedInputTokens: 900,
      cacheCreationInputTokens: 50
    });
  });

  it("opens the first content block at index 0 even when a reasoning item is dropped", async () => {
    // A reasoning item with no summary and no encrypted_content is dropped, but it
    // had already consumed index 0 — so the text block opened at index 1 and
    // nothing ever opened at 0. A consumer that assigns content by index gets a
    // hole; only push-based accumulators survived it.
    const sse = await pump(createResponsesToAnthropicStream(), [
      ["response.created", { type: "response.created", response: { id: "resp_2", model: "m" } }],
      ["response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [] }
      }],
      ["response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [] }
      }],
      ["response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: "msg_1",
        output_index: 1,
        content_index: 0,
        delta: "hello"
      }],
      ["response.completed", {
        type: "response.completed",
        response: { id: "resp_2", model: "m", status: "completed", output: [] }
      }]
    ]);

    const starts = events(sse).filter((event) => event.type === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ index: 0, content_block: { type: "text" } });
    for (const event of events(sse).filter((item) => typeof item.index === "number")) {
      expect(event.index).toBe(0);
    }
  });

  it("turns an untranslatable upstream body into a readable error, not a dropped socket", async () => {
    // The status line and headers are already on the wire when the buffered
    // converter runs, so throwing there destroyed the socket with zero bytes
    // written: the client saw "fetch failed" and the log's error_summary was
    // overwritten with the converter's complaint, losing the upstream's own text.
    for (const [label, transform, expected] of [
      [
        "anthropic client",
        createResponsesToAnthropicResponseTransform(502, { "content-type": "text/html" }),
        { type: "error" }
      ],
      [
        "openai client",
        createAnthropicToResponsesResponseTransform(500, { "content-type": "text/plain" }),
        {}
      ]
    ] as const) {
      const source = Readable.from(["<html><body>502 Bad Gateway</body></html>"]);
      const chunks: Buffer[] = [];
      source.pipe(transform.stream);
      for await (const chunk of transform.stream) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      expect(body, label).toMatchObject(expected);
      const message = (body.error as Record<string, unknown>).message;
      expect(String(message), label).toContain("502 Bad Gateway");
      expect(String(message), label).toContain("[compactgate]");
    }
  });

  it("still reports the request as failed after emitting the fallback", async () => {
    // The envelope keeps the client from seeing a dropped socket, but the request
    // did fail. On a 2xx nothing else marks it, so without an out-of-band signal
    // failover would read it as a success — resetting the profile's failure counters
    // and reinforcing stickiness onto an upstream that just returned garbage.
    const transform = createAnthropicToResponsesResponseTransform(200, {
      "content-type": "application/json"
    });
    const source = Readable.from(["<html>not json at all</html>"]);
    source.pipe(transform.stream);
    for await (const _chunk of transform.stream) {
      // drain
    }

    expect(transform.translationError).toBeTruthy();
    expect(String(transform.translationError)).toContain("[compactgate]");
  });

  it("frames that fallback as SSE when the response already announced a stream", async () => {
    const transform = createResponsesToAnthropicResponseTransform(503, {
      "content-type": "text/event-stream"
    });
    // An event-stream response cannot carry a bare JSON object mid-flight; that is
    // no more parseable to the client than the dropped socket was.
    expect(transform.responseHeaders["content-type"]).toContain("text/event-stream");
  });
});

describe("the stream observer decodes text that straddles a chunk boundary", () => {
  it("still sees the terminal event when a multi-byte character is split", async () => {
    const observer = createOpenAiStreamObserver({ "content-type": "text/event-stream" });
    if (!observer) {
      throw new Error("Expected an SSE observer for an event-stream response.");
    }
    const frame = Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","text":"中文"}\n\n'
    );
    // Split inside the three-byte UTF-8 sequence for the first character. Decoding
    // per chunk turned the halves into replacement characters, garbling whatever
    // observed text straddled a boundary.
    const cut = frame.indexOf(Buffer.from("中")) + 1;
    observer.observe(frame.subarray(0, cut));
    observer.observe(frame.subarray(cut));

    const summary = await observer.finish();
    expect(summary).toMatchObject({
      sawCompletedEvent: true,
      terminalEvent: "response.completed",
      eventCount: 1,
      decodeError: false
    });
  });
});
