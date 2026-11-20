import { expect, it } from "vitest";
import { captureRequest, postJson, startApp, startUpstream, type CapturedRequest } from "./helpers/server-test-utils.js";

it.each([
  ["POST", "/v1/responses", true],
  ["POST", "/v1/responses/input_tokens", false],
  ["PATCH", "/v1/responses", false],
  ["GET", "/v1/responses", false],
  ["GET", "/v1/models", false],
  ["POST", "/v1/responses/compact", true],
  ["PUT", "/v1/responses/compact", true]
] as const)("previews actual Responses conversion for %s %s", async (method, path, converted) => {
  const requests: CapturedRequest[] = [];
  const upstream = await startUpstream(async (req, res) => {
    requests.push(await captureRequest(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "Synthetic answer" }], data: [] }));
  });
  const app = await startApp(upstream.url, upstream.url, {
    primary: { upstream_protocol: "anthropic_messages" }, compact: { upstream_protocol: "anthropic_messages" }
  });
  const body = { model: "synthetic", input: "hello" };
  const preview = await postJson(app.url, "/api/test-route", { method, path, body }).then(res => res.json());
  const actual = await fetch(app.url + path, { method, headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  await actual.text();
  expect(actual.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(preview.translation_mode).toBe(converted ? "translate" : "passthrough");
  expect(new URL(preview.upstream_url).pathname).toBe(requests[0].url);
  if (method !== "GET") {
    const sent = JSON.parse(requests[0].body);
    expect(Array.isArray(sent.messages)).toBe(converted);
    if (!converted) expect(sent.input).toBe(body.input);
  }
});

it.each([
  ["POST", "/anthropic/v1/messages", true],
  ["POST", "/anthropic/messages", true],
  ["POST", "/anthropic/v1/messages/count_tokens", true],
  ["POST", "/anthropic/v1/custom", false],
  ["PATCH", "/anthropic/v1/messages", false],
  ["GET", "/anthropic/v1/messages", false],
  ["GET", "/anthropic/v1/models", false]
] as const)("previews actual Messages conversion for %s %s", async (method, path, converted) => {
  const requests: CapturedRequest[] = [];
  const upstream = await startUpstream(async (req, res) => {
    requests.push(await captureRequest(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_synthetic", object: "response", status: "completed", output: [], input_tokens: 5, data: [] }));
  });
  const app = await startApp(undefined, undefined, {
    claude: { primary: { base_url: upstream.url, upstream_protocol: "openai_responses" } }
  });
  const body = { model: "synthetic", max_tokens: 20, messages: [{ role: "user", content: "hello" }] };
  const preview = await postJson(app.url, "/api/test-route", { method, path, body }).then(res => res.json());
  const actual = await fetch(app.url + path, { method, headers: { "content-type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  await actual.text();
  expect(actual.status).toBe(200);
  expect(requests).toHaveLength(1);
  expect(preview.translation_mode).toBe(converted ? "translate" : "passthrough");
  expect(new URL(preview.upstream_url).pathname).toBe(requests[0].url);
  if (method !== "GET") {
    const sent = JSON.parse(requests[0].body);
    expect(Array.isArray(sent.input)).toBe(converted);
    if (!converted) expect(sent.messages).toEqual(body.messages);
  }
});
