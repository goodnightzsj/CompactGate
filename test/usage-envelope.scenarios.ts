import { expect, it } from "vitest";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

it.each([["anthropic", false], ["anthropic", true], ["openai", false], ["openai", true]] as const)("keeps authoritative %s envelope usage, relay padding=%s", async (protocol, padded) => {
  const zero = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const padding = padded ? { usage: zero } : {};
  const frame = (type: string, payload: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  const text = protocol === "anthropic"
    ? frame("message_start", { ...padding, message: { id: "msg_synthetic", type: "message", role: "assistant", model: "synthetic", content: [],
        usage: { input_tokens: 123, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 200 } } }) +
      frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }) +
      frame("message_stop", padding)
    : frame("response.completed", { ...padding, response: { id: "resp_synthetic", object: "response", model: "synthetic", status: "completed", output: [],
        usage: { input_tokens: 823, output_tokens: 20, total_tokens: 843, input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 } } } });
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(text);
  });
  const app = await startApp(upstream.url, undefined, { claude: { base_url: upstream.url, api_key: "synthetic" } });
  const response = await postJson(app.url, protocol === "anthropic" ? "/anthropic/v1/messages" : "/v1/responses", {
    model: "synthetic", stream: true, input: "synthetic", messages: [{ role: "user", content: "synthetic" }]
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(text);
  const entry = await waitForLogEntry(app.url, row => row.request_id === response.headers.get("x-compactgate-request-id"));
  expect(entry.stream_outcome).toBe("success");
  expect.soft(entry).toMatchObject({ input_tokens: protocol === "anthropic" ? 123 : 823, output_tokens: 20,
    cache_creation_input_tokens: 200, total_tokens: 843 });
  const stats = await fetch(`${app.url}/api/logs/stats?view=usage`).then(value => value.json());
  expect(stats.summary).toMatchObject({ input_tokens: 823, output_tokens: 20, cache_read_tokens: 500,
    cache_creation_tokens: 200, total_tokens: 843 });
});
