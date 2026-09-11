import { execFile } from "node:child_process";
import http, { type Server, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexResponseTransform } from "../src/server/oauth-response.js";
import {
  classifyAnthropicUpstreamResult, classifyOpenAiUpstreamResult,
  sendBufferedUpstreamRequest, type BufferedUpstreamOptions, type BufferedUpstreamResult
} from "../src/server/upstream-client.js";
import { close, listen } from "./helpers/server-test-lifecycle.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const servers: Server[] = [];
const outputFormats = [
  { clientStream: false, anthropic: false, label: "Codex JSON" },
  { clientStream: true, anthropic: false, label: "Codex SSE" },
  { clientStream: false, anthropic: true, label: "Claude JSON" },
  { clientStream: true, anthropic: true, label: "Claude SSE" }
];

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await close(server);
  }
});

async function startServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
  return `http://127.0.0.1:${address.port}`;
}

async function abortAfterEvent(
  event: unknown,
  options: Pick<BufferedUpstreamOptions, "responseTransform" | "streamProtocol"> = {}
) {
  let upstreamResponse: ServerResponse | undefined;
  const upstream = await startServer((_req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  let settle!: (value: BufferedUpstreamResult | Error) => void;
  const settled = new Promise<BufferedUpstreamResult | Error>((resolve) => { settle = resolve; });
  const proxy = await startServer(async (req, res) => {
    try {
      settle(await sendBufferedUpstreamRequest({
        req, res, upstream: new URL(upstream), startedAt: performance.now(),
        timeoutMs: 1500, timeoutMessage: "synthetic upstream timeout",
        requestHeaders: {}, body: Buffer.alloc(0), extraResponseHeaders: {}, ...options
      }));
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
      res.destroy();
    }
  });
  const response = await fetch(proxy, { signal: AbortSignal.timeout(1500) });
  expect(response.status).toBe(200);
  // The terminal has reached the client before the upstream socket is closed.
  upstreamResponse!.destroy();
  const body = await response.text().catch((error: Error) => error);
  const result = await Promise.race([
    settled,
    delay(1500, new Error("Upstream sender did not settle."), { ref: false })
  ]);
  if (result instanceof Error) throw result;
  if (body instanceof Error) throw body;
  expect(result).toMatchObject({ status: 200, clientDisconnectPhase: "none" });
  return { body, result };
}

// A rejected transform must not terminate the real Node process. Running this
// boundary in a child also keeps a regression from crashing the test runner.
const malformedResponseScript = `
import http from "node:http";
import { once } from "node:events";
import { sendBufferedUpstreamRequest } from "./src/server/upstream-client.ts";
import { createCodexResponseTransform } from "./src/server/oauth-response.ts";
const servers = [];
async function start(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}
const outcome = {};
try {
  const upstream = await start((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(process.argv[1] === "oversize"
      ? "data: " + "x".repeat(8 * 1024 * 1024 + 1)
      : "data: not-json\\n\\n");
  });
  const proxy = await start(async (req, res) => {
    try {
      await sendBufferedUpstreamRequest({
        req, res, upstream: new URL(upstream), startedAt: performance.now(),
        timeoutMs: 1500, timeoutMessage: "synthetic upstream timeout",
        requestHeaders: {}, body: Buffer.alloc(0), extraResponseHeaders: {},
        responseTransform: (status, headers) => createCodexResponseTransform(status, headers, true)
      });
      outcome.unexpectedSuccess = true;
    } catch (error) {
      outcome.message = error.message;
      outcome.status = error.details?.status;
      res.destroy();
    }
  });
  try { await (await fetch(proxy, { signal: AbortSignal.timeout(2000) })).text(); }
  catch (error) { outcome.clientError = error.name; }
  await new Promise(resolve => setImmediate(resolve));
} finally {
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
console.log(JSON.stringify(outcome));
`;

describe("upstream response transform lifecycle", () => {
  it.each([
    ["malformed", "Codex returned an invalid SSE event."],
    ["oversize", "Codex SSE event exceeded the size limit."]
  ])("handles %s SSE without an unhandled rejection and preserves the transform error", async (kind, message) => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "-e", malformedResponseScript, kind
    ], { cwd: root, timeout: 6000 });
    expect(JSON.parse(stdout)).toMatchObject({ message, status: 200 });
    expect(JSON.parse(stdout).unexpectedSuccess).toBeUndefined();
  }, 8000);

  it.each(outputFormats)("finishes $label when upstream aborts after response.done", async ({ clientStream, anthropic }) => {
    const { body, result } = await abortAfterEvent({
      type: "response.done",
      response: {
        id: "resp_synthetic", status: "completed", model: "synthetic-model",
        output: [{
          id: "msg_synthetic", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "synthetic complete response" }]
        }],
        usage: { input_tokens: 12, output_tokens: 3 }
      }
    }, {
      responseTransform: (status, headers) => createCodexResponseTransform(status, headers, clientStream, anthropic)
    });
    expect(result.errorSummary).toBeNull();
    expect(body).toContain("synthetic complete response");
    expect(body).toContain("input_tokens");
    if (clientStream) {
      expect(body).toContain(anthropic ? "message_stop" : "response.completed");
      expect(result.clientStreamSummary?.sawCompletedEvent).toBe(true);
    } else {
      expect(JSON.parse(body)).toMatchObject(anthropic
        ? { type: "message", content: [{ type: "text", text: "synthetic complete response" }] }
        : { status: "completed", output: [{ id: "msg_synthetic" }] });
    }
  });

  it.each([
    { streamProtocol: "openai" as const, event: { type: "response.completed", response: { status: "completed" } } },
    { streamProtocol: "anthropic" as const, event: { type: "message_stop" } }
  ])("ends the untransformed $streamProtocol response after an upstream terminal abort", async ({ streamProtocol, event }) => {
    const { body, result } = await abortAfterEvent(event, { streamProtocol });
    expect(body).toBe(`data: ${JSON.stringify(event)}\n\n`);
    expect(result.errorSummary).toBeNull();
    expect(result.streamSummary?.sawCompletedEvent).toBe(true);
    const classify = streamProtocol === "anthropic" ? classifyAnthropicUpstreamResult : classifyOpenAiUpstreamResult;
    expect(classify(result)).toBe("success");
  });

  it.each([
    { streamProtocol: "openai" as const, event: { type: "response.failed", response: { status: "failed", error: { message: "synthetic failure" } } }, outcome: "upstream_stream_incomplete" },
    { streamProtocol: "openai" as const, event: { type: "response.incomplete", response: { status: "incomplete" } }, outcome: "upstream_stream_incomplete" },
    { streamProtocol: "anthropic" as const, event: { type: "error", error: { type: "api_error", message: "synthetic failure" } }, outcome: "upstream_stream_error" }
  ])("retains the failure of untransformed $event.type after upstream abort", async ({ streamProtocol, event, outcome }) => {
    const { body, result } = await abortAfterEvent(event, { streamProtocol });
    expect(body).toBe(`data: ${JSON.stringify(event)}\n\n`);
    expect(result.streamSummary?.sawTerminalEvent).toBe(true);
    const classify = streamProtocol === "anthropic" ? classifyAnthropicUpstreamResult : classifyOpenAiUpstreamResult;
    expect(classify(result)).toBe(outcome);
  });

  it.each(["failed", "incomplete"].flatMap((status) => outputFormats.map((format) => ({ ...format, status }))))(
    "keeps response.$status unsuccessful when converted to $label",
    async ({ status, clientStream, anthropic }) => {
      const { result } = await abortAfterEvent({
        type: `response.${status}`,
        response: {
          id: "resp_synthetic_failure", status, output: [], usage: { input_tokens: 12, output_tokens: 3 },
          ...(status === "failed"
            ? { error: { message: "synthetic upstream failure" } }
            : { incomplete_details: { reason: "max_output_tokens" } })
        }
      }, {
        responseTransform: (code, headers) => createCodexResponseTransform(code, headers, clientStream, anthropic)
      });
      expect(result.errorSummary).toBeTruthy();
      // Both proxy callers classify the translated client protocol, whose JSON
      // form has no stream observer and whose Claude form can end in message_stop.
      const clientResult = { ...result, streamSummary: result.clientStreamSummary ?? null };
      const classify = anthropic ? classifyAnthropicUpstreamResult : classifyOpenAiUpstreamResult;
      expect(classify(clientResult)).not.toBe("success");
    }
  );
});
