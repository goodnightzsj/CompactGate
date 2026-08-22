import { describe, expect, it } from "vitest";
import { providerStateLegacyFailureKey } from "../src/server/provider-state-evidence.js";
import { createAnthropicToResponsesStream } from "../src/server/protocol-stream.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";

describe("upstream results are not charged to the wrong party", () => {
  it("counts a repeated legacy failure even though error bodies differ", () => {
    const scope = {
      targetStateDomain: "domain-a",
      model: "gpt-5.5",
      endpoint: "/v1/responses"
    };
    const first = legacyResult('{"error":{"message":"bad state"},"request_id":"req_aaa"}');
    const second = legacyResult('{"error":{"message":"bad state"},"request_id":"req_bbb"}');

    // Same conversation, same target, same failure mode: the two-strike
    // threshold has to see one key, not two. Hashing the response bytes gave
    // every attempt a fresh key because real bodies carry a per-request id.
    expect(providerStateLegacyFailureKey(scope, "conv-1", first))
      .toBe(providerStateLegacyFailureKey(scope, "conv-1", second));

    // A different status is still a different mode.
    expect(providerStateLegacyFailureKey(scope, "conv-1", { ...first, status: 409 }))
      .not.toBe(providerStateLegacyFailureKey(scope, "conv-1", first));
    // And a different conversation never shares a counter.
    expect(providerStateLegacyFailureKey(scope, "conv-2", first))
      .not.toBe(providerStateLegacyFailureKey(scope, "conv-1", first));
  });
});

describe("stream conversion survives one bad frame", () => {
  it("keeps converting after a frame that is not valid JSON", async () => {
    const transform = createAnthropicToResponsesStream();
    const chunks: string[] = [];
    transform.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

    const finished = new Promise<void>((resolve, reject) => {
      transform.on("end", () => resolve());
      transform.on("error", reject);
    });

    transform.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5"}}\n\n');
    // A truncated or junk frame used to reject the Transform, which destroyed
    // the whole response rather than skipping this one event.
    transform.write('event: ping\ndata: {"type":"content_block_de\n\n');
    transform.write('data: not json at all\n\n');
    transform.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    transform.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n');
    transform.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
    transform.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n');
    transform.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    transform.end();
    await finished;

    const output = chunks.join("");
    expect(output).toContain("response.created");
    expect(output).toContain("hello");
    expect(output).toContain("response.completed");
    expect(output).not.toContain("upstream_stream_incomplete");
  });
});

function legacyResult(body: string): BufferedUpstreamResult {
  return {
    status: 400,
    responseBody: Buffer.from(body),
    responseBodyTruncated: false,
    responseHeaders: { "content-type": "application/json" },
    errorSummary: "Upstream returned HTTP 400: bad state",
    firstTokenMs: null,
    streamSummary: null,
    clientDisconnectPhase: "none"
  } as unknown as BufferedUpstreamResult;
}
