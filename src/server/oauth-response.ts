import type { IncomingHttpHeaders } from "node:http";
import { Duplex, Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isRecord, readHeaderString } from "./http-utils.js";
import { openAiResponseToAnthropic } from "./protocol-conversion.js";
import { createResponsesToAnthropicStream } from "./protocol-stream.js";
import { sseDataFrames } from "./sse-frames.js";
import type { UpstreamResponseTransform } from "./upstream-client.js";

/** Codex speaks SSE even for a JSON request; normalize its terminal event once. */
export function createCodexResponseTransform(
  status: number, headers: IncomingHttpHeaders, clientStream: boolean, anthropic = false
): UpstreamResponseTransform | null {
  if (status >= 400 || !(readHeaderString(headers["content-type"]) ?? "").includes("text/event-stream")) return null;
  if (!["", "identity"].includes(readHeaderString(headers["content-encoding"]) ?? "")) {
    throw new Error("Codex ignored the identity encoding request.");
  }
  const responseHeaders: IncomingHttpHeaders = { ...headers, "content-type": clientStream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8" };
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) delete responseHeaders[name];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let outputBytes = 0;
  const items = new Map<number, unknown>();
  const limit = 8 * 1024 * 1024;
  const result: UpstreamResponseTransform = {
    stream: new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          pending += decoder.write(chunk);
          drain(this, false);
          callback();
        } catch (error) { callback(error as Error); }
      },
      flush(callback) {
        try {
          pending += decoder.end();
          drain(this, true);
          if (!result.sawTerminalEvent) {
            const message = "Codex stream ended without a terminal response.";
            result.translationError = message;
            emit(this, { type: "response.failed", response: { status: "failed", error: { type: "upstream_stream_incomplete", message } } });
          }
          callback();
        } catch (error) { callback(error as Error); }
      }
    }),
    responseHeaders, streamProtocol: anthropic ? "anthropic" : "openai"
  };
  if (clientStream && anthropic) {
    const input = result.stream;
    result.stream = Duplex.from({ writable: input, readable: input.compose(createResponsesToAnthropicStream()) });
  }
  return result;

  function emit(stream: Transform, event: Record<string, unknown>): void {
    if (clientStream) {
      stream.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } else if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) {
      const body = Buffer.from(JSON.stringify(event.response));
      stream.push(anthropic ? openAiResponseToAnthropic(body, status) : body);
    }
  }

  function frame(stream: Transform, raw: string): void {
    if (result.sawTerminalEvent) return;
    for (const data of sseDataFrames(raw)) {
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { throw new Error("Codex returned an invalid SSE event."); }
      if (!isRecord(parsed) || typeof parsed.type !== "string") throw new Error("Codex returned a malformed SSE event.");
      const event = parsed;
      if (event.type === "response.output_item.done" && Number.isSafeInteger(event.output_index) && isRecord(event.item)) {
        outputBytes += Buffer.byteLength(JSON.stringify(event.item));
        if (outputBytes > limit) throw new Error("Codex response exceeded the aggregation limit.");
        items.set(event.output_index as number, event.item);
      }
      if (event.type === "response.done") event.type = "response.completed";
      if (event.type === "error") {
        event.type = "response.failed";
        event.response = { status: "failed", error: event.error ?? { message: "Codex rejected the request." } };
      }
      if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) {
        if (!isRecord(event.response)) throw new Error("Codex terminal event has no response object.");
        const response = event.response;
        if (!Array.isArray(response.output) || response.output.length === 0) {
          response.output = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
        }
        if (response.status === "failed" || response.status === "incomplete") event.type = `response.${response.status}`;
        response.status ??= String(event.type).slice("response.".length);
        if (!["completed", "failed", "incomplete"].includes(String(response.status))) throw new Error("Codex returned an invalid terminal status.");
        if (event.type !== "response.completed") result.translationError = `Codex ended with ${event.type}.`;
        result.sawTerminalEvent = true;
      }
      emit(stream, event);
    }
  }

  function drain(stream: Transform, final: boolean): void {
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(pending);
      if (!separator) break;
      if (Buffer.byteLength(pending.slice(0, separator.index)) > limit) throw new Error("Codex SSE event exceeded the size limit.");
      frame(stream, pending.slice(0, separator.index));
      pending = pending.slice(separator.index + separator[0].length);
    }
    if (Buffer.byteLength(pending) > limit) throw new Error("Codex SSE event exceeded the size limit.");
    if (final && pending.trim()) frame(stream, pending);
  }
}
