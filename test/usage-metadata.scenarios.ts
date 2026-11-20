import { expect, it } from "vitest";
import { captureBody, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

it.each([false, true])("ignores user metadata when recording response usage, stream=%s", async stream => {
  const metadata = { input_tokens: "12345", output_tokens: "6789", cache_read_input_tokens: "700000", usage: { total_tokens: 999999 } };
  const response = { id: "resp_metadata", object: "response", status: "in_progress", model: "fixture", output: [], usage: null, metadata };
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    if (!stream) return writeJsonResponse(res, response);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.created", response })}\n\n`);
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: {
      ...response, status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    } })}\n\n`);
  });
  const app = await startApp(upstream.url);
  const result = await postJson(app.url, "/v1/responses", { model: "fixture", input: "synthetic", stream, metadata });
  expect(result.status).toBe(200);
  await result.text();
  const entry = await waitForLogEntry(app.url, log => log.request_id === result.headers.get("x-compactgate-request-id"));
  expect(entry).toMatchObject({ input_tokens: stream ? 10 : null, output_tokens: stream ? 2 : null,
    total_tokens: stream ? 12 : null, cache_read_input_tokens: null, additive_cached_input_tokens: false });
});
