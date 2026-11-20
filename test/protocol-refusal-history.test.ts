import { describe, expect, it } from "vitest";
import { chatCompletionToResponses, responsesRequestToAnthropic, responsesRequestToChat } from "../src/server/protocol-conversion.js";
import { captureBody, postJson, startApp, startUpstream } from "./helpers/server-test-utils.js";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const refusal = "I cannot fulfill that request.";
function upstreamAnswer(refused: boolean) {
  return { id: "chatcmpl_synthetic", model: "synthetic", choices: [{ index: 0, finish_reason: "stop", message: {
    role: "assistant", content: refused ? null : "An ordinary answer.", ...(refused ? { refusal } : {})
  } }] };
}

describe.each([
  ["chat", responsesRequestToChat],
  ["messages", responsesRequestToAnthropic]
] as const)("replay prior assistant output through %s", (_kind, convert) => {
  it("preserves mixed text and refusal in order", () => {
    const translated = JSON.parse(convert(bytes({ model: "synthetic", input: [{ role: "assistant", content: [
      { type: "output_text", text: "Before." }, { type: "refusal", refusal }, { type: "output_text", text: "After." }
    ] }] })).toString());
    expect(translated.messages[0]).toEqual({ role: "assistant", content: [
      { type: "text", text: "Before." },
      _kind === "chat" ? { type: "refusal", refusal } : { type: "text", text: refusal },
      { type: "text", text: "After." }
    ] });
  });
  it.each(["user", "system", "developer"])("still rejects a refusal block from %s", role => {
    expect(() => convert(bytes({ model: "synthetic", input: [{ role, content: [{ type: "refusal", refusal }] }] })))
      .toThrow(/Unsupported Responses content block/);
  });
  it.each([{ type: "refusal", refusal: 42 }, { type: "unknown", text: "invalid" }])("rejects malformed assistant content %j", block => {
    expect(() => convert(bytes({ model: "synthetic", input: [{ role: "assistant", content: [block] }] })))
      .toThrow(/Unsupported Responses content block/);
  });
  it.each([false, true])("accepts this project's own response output, refusal=%s", refused => {
    const response = JSON.parse(chatCompletionToResponses(bytes(upstreamAnswer(refused)), 200).toString());
    const nextTurn = { model: "synthetic", input: [
      { role: "user", content: "First question." }, ...response.output, { role: "user", content: "A different benign question." }
    ] };
    const translated = JSON.parse(convert(bytes(nextTurn)).toString());
    expect(JSON.stringify(translated.messages)).toContain(refused ? refusal : "An ordinary answer.");
    expect(JSON.stringify(translated.messages)).toContain("A different benign question.");
  });
});

it.each([false, true])("continues a real Chat-backed conversation after first-turn refusal=%s", async refused => {
  let attempts = 0;
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    attempts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(upstreamAnswer(attempts === 1 && refused)));
  });
  const app = await startApp(upstream.url, undefined, { primary: { upstream_protocol: "openai_chat" } });
  const first = await postJson(app.url, "/v1/responses", { model: "synthetic", input: "First question." });
  expect(first.status).toBe(200);
  const prior = await first.json();
  expect(prior.output[0].content[0].type).toBe(refused ? "refusal" : "output_text");
  const second = await postJson(app.url, "/v1/responses", { model: "synthetic", input: [
    { role: "user", content: "First question." }, ...prior.output, { role: "user", content: "A different benign question." }
  ] });
  const response = await second.json();
  expect({ status: second.status, attempts, error: response.error ?? null }).toEqual({ status: 200, attempts: 2, error: null });
});
