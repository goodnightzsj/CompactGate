import http, { type Server, type ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexResponseTransform } from "../src/server/oauth-response.js";
import {
  classifyOpenAiUpstreamResult, sendBufferedUpstreamRequest, UpstreamRequestError,
  type BufferedUpstreamOptions, type BufferedUpstreamResult
} from "../src/server/upstream-client.js";
import { close, listen } from "./helpers/server-test-lifecycle.js";

const servers: Server[] = [];

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

async function downstreamError(
  event: unknown,
  responseTransform?: BufferedUpstreamOptions["responseTransform"],
  duringResolution: false | "error" | "close" = false,
  flushError?: Error
) {
  const upstream = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (duringResolution) res.end();
  });
  let settle!: (result: BufferedUpstreamResult | Error) => void;
  const settled = new Promise<BufferedUpstreamResult | Error>((resolve) => { settle = resolve; });
  const fault = Object.assign(new Error("synthetic write EPIPE"), { code: "EPIPE" });
  let faultCount = 0;
  const proxy = await startServer(async (req, res) => {
    const emitError = () => { faultCount += 1; res.emit("error", fault); };
    if (duringResolution) {
      responseTransform = (_status, headers) => ({
        responseHeaders: headers,
        streamProtocol: "openai",
        stream: new Transform({
          transform(chunk, _encoding, callback) { callback(null, chunk); },
          flush(callback) {
            // HTTP EOF starts result resolution while the adapter is still
            // flushing. A downstream error must not steal that settlement.
            setImmediate(() => {
              if (duringResolution === "close") {
                faultCount += 1;
                res.once("close", () => setImmediate(() => callback(flushError)));
                res.destroy();
              } else {
                emitError();
                callback(flushError);
              }
            });
          }
        })
      });
    } else {
      const write = res.write;
      res.write = function (this: ServerResponse, ...args: Parameters<typeof write>) {
        const accepted = write.apply(this, args);
        // Inject at the real HTTP sink, after observers have seen these bytes.
        if (faultCount === 0) emitError();
        return accepted;
      } as typeof write;
    }
    try {
      settle(await sendBufferedUpstreamRequest({
        req, res, upstream: new URL(upstream), startedAt: performance.now(),
        timeoutMs: 1500, timeoutMessage: "synthetic upstream timeout",
        requestHeaders: {}, body: Buffer.alloc(0), extraResponseHeaders: {}, responseTransform
      }));
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    } finally {
      res.destroy();
    }
  });
  // The transport may fail or deliver a partial body; settlement is the contract
  // under test, not successful delivery through the deliberately broken sink.
  const client = fetch(proxy, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.text()).catch((error: unknown) => error);
  const result = await settled;
  await client;
  expect(faultCount).toBe(1);
  return { result, fault };
}

function requireResult(result: BufferedUpstreamResult | Error): BufferedUpstreamResult {
  if (result instanceof Error) throw result;
  return result;
}

describe("downstream errors preserve upstream terminal ownership", () => {
  it("keeps an EPIPE before the terminal classified as client cancellation", async () => {
    const { result, fault } = await downstreamError({ type: "response.created", response: { id: "resp_test" } });
    expect(result).toBeInstanceOf(UpstreamRequestError);
    expect(result).toMatchObject({ cause: fault, details: { kind: "client_cancel", streamSummary: { sawTerminalEvent: false } } });
  });

  it.each(["completed", "failed"])("preserves response.%s after a downstream EPIPE", async (status) => {
    const event = { type: `response.${status}`, response: { status, error: status === "failed" ? { message: "synthetic upstream failure" } : undefined } };
    const { result } = await downstreamError(event);
    const value = requireResult(result);
    expect(value).toMatchObject({ status: 200, clientDisconnectPhase: "after_terminal", streamSummary: { sawTerminalEvent: true, terminalEvent: `response.${status}` } });
    expect(value.responseBody.toString()).toContain(`response.${status}`);
    expect(classifyOpenAiUpstreamResult(value)).toBe(status === "failed" ? "upstream_stream_incomplete" : "success");
  });

  it.each([true, false])("preserves the Codex source terminal with clientStream=%s after EPIPE", async (clientStream) => {
    const { result } = await downstreamError({
      type: "response.done", response: { id: "resp_test", status: "completed", output: [] }
    }, (status, headers) => createCodexResponseTransform(status, headers, clientStream));
    const value = requireResult(result);
    expect(value.clientDisconnectPhase).toBe("after_terminal");
    expect(value.errorSummary).toBeNull();
    expect(value.clientResponseBody?.toString()).toContain('"status":"completed"');
    expect(classifyOpenAiUpstreamResult({ ...value, streamSummary: value.clientStreamSummary ?? null })).toBe("success");
  });

  it.each(["error", "close"] as const)("does not replace an EOF settlement when the client emits %s during adapter flush", async (disconnect) => {
    const { result } = await downstreamError({ type: "response.completed", response: { status: "completed" } }, undefined, disconnect);
    const value = requireResult(result);
    expect(value.errorSummary).toBeNull();
    expect(value.clientStreamSummary?.sawCompletedEvent).toBe(true);
    expect(classifyOpenAiUpstreamResult(value)).toBe("success");
  });

  it.each(["error", "close"] as const)("preserves an actual adapter flush failure after client %s during EOF settlement", async (disconnect) => {
    const flushError = new Error("synthetic adapter flush failure");
    const { result } = await downstreamError({ type: "response.completed", response: { status: "completed" } }, undefined, disconnect, flushError);
    expect(result).toBeInstanceOf(UpstreamRequestError);
    expect(result).toMatchObject({
      message: flushError.message,
      cause: flushError,
      details: { kind: "upstream_stream_incomplete", status: 200 }
    });
  });
});
