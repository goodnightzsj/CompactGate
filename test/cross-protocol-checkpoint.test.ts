import type { ServerResponse } from "node:http";
import { expect, it } from "vitest";
import { sseDataFrames } from "../src/server/sse-frames.js";
import { captureRequest, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse } from "./helpers/server-test-utils.js";

type Protocol = "openai_chat" | "anthropic_messages";
const cases = (["openai_chat", "anthropic_messages"] as const).flatMap(protocol =>
  [false, true].flatMap(stream => [false, true].map(degraded => ({ protocol, stream, degraded }))));

it.each(cases)("continues every new response ID through $protocol (stream=$stream, degraded=$degraded)", async ({ protocol, stream, degraded }) => {
  const requests: Record<string, unknown>[] = [];
  const upstream = await startUpstream(async (req, res) => {
    requests.push(JSON.parse((await captureRequest(req)).body));
    if (requests.length === 1) {
      writeJsonResponse(res, { id: "resp_first", status: "completed", output: [
        ...(degraded ? [{ type: "reasoning", summary: [] }] : []),
        { type: "message", role: "assistant", content: "Recorded." }
      ] });
    } else writeTranslated(res, protocol, stream, requests.length);
  });
  const app = await startApp(upstream.url, upstream.url, { primary_failover: { state_recovery_retention_hours: 1 } });
  const send = async (input: unknown, previous?: string) => {
    const response = await postJson(app.url, "/v1/responses", {
      model: "synthetic", input, stream: Boolean(previous) && stream,
      ...(previous ? { previous_response_id: previous } : {})
    }, { "x-compactgate-session": "multi-turn-checkpoint" });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    await waitForLogEntry(app.url, entry => entry.request_id === response.headers.get("x-compactgate-request-id"));
    if (previous) expect(response.headers.get("x-compactgate-context-fidelity")).toBe(degraded ? "degraded" : "exact");
    const body = response.headers.get("content-type")?.includes("text/event-stream")
      ? sseDataFrames(text).map(data => JSON.parse(data)).find(event => event.type === "response.completed")?.response
      : JSON.parse(text);
    expect(body?.status).toBe("completed");
    return body as { id: string; output: Array<Record<string, unknown>> };
  };
  let response = await send("Remember eu-west-2.");
  await app.config.patch({ primary: { upstream_protocol: protocol } });
  response = await send("Look up the region.", response.id);
  expect(response.output).toContainEqual(expect.objectContaining({ type: "function_call", call_id: "call_lookup", name: "lookup" }));
  response = await send([{ type: "function_call_output", call_id: "call_lookup", output: "eu-west-2 result" }], response.id);
  await send("Repeat your last answer.", response.id);
  expect(requests).toHaveLength(4);
  for (const request of requests.slice(1)) expect(request).not.toHaveProperty("previous_response_id");
  const history = JSON.stringify(requests[3].messages);
  for (const text of ["Remember eu-west-2.", "Recorded.", "Look up the region.", "eu-west-2 result", "The region is eu-west-2.", "Repeat your last answer."]) {
    expect(history.split(text)).toHaveLength(2);
  }
  expect(history).toContain("call_lookup");
});

function writeTranslated(res: ServerResponse, protocol: Protocol, stream: boolean, turn: number): void {
  const id = `converted_${turn}`;
  const tool = turn === 2;
  const text = "The region is eu-west-2.";
  const content = tool ? { type: "tool_use", id: "call_lookup", name: "lookup", input: { region: "eu-west-2" } }
    : { type: "text", text };
  const message = tool ? { role: "assistant", content: null, tool_calls: [{ id: "call_lookup", type: "function", function: { name: "lookup", arguments: '{"region":"eu-west-2"}' } }] }
    : { role: "assistant", content: text };
  if (!stream) {
    writeJsonResponse(res, protocol === "openai_chat"
      ? { id, choices: [{ message, finish_reason: tool ? "tool_calls" : "stop" }] }
      : { id, type: "message", content: [content], stop_reason: tool ? "tool_use" : "end_turn" });
    return;
  }
  const events = protocol === "openai_chat" ? [
    { id, choices: [{ index: 0, delta: message, finish_reason: tool ? "tool_calls" : "stop" }] }
  ] : [
    { type: "message_start", message: { id, role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" } },
    { type: "message_stop" }
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + (protocol === "openai_chat" ? "data: [DONE]\n\n" : ""));
}
