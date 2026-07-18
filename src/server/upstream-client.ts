import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse
} from "node:http";
import https from "node:https";
import { copyResponseHeaders, decodeBodyText } from "./http-utils.js";
import { createOpenAiStreamObserver, type OpenAiStreamSummary } from "./upstream-openai-stream.js";
import { resolveUpstreamAgent } from "./upstream-proxy-agent.js";
import {
  appendBufferedResponseChunk,
  normalizeMaxBufferedResponseBytes,
  normalizeMaxObservedStreamEventBytes
} from "./upstream-response-buffer.js";
import { extractResponseErrorSummary } from "./usage.js";
import type { ClientDisconnectPhase, StreamOutcome } from "../shared/types.js";

export {
  DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES,
  DEFAULT_MAX_JSON_RESPONSE_BYTES,
  DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES
} from "./upstream-response-buffer.js";
export {
  requestJson,
  UpstreamStatusError
} from "./upstream-json-client.js";
export type { RequestJsonOptions } from "./upstream-json-client.js";

export interface BufferedUpstreamOptions {
  req: IncomingMessage;
  res: ServerResponse;
  upstream: URL;
  startedAt: number;
  timeoutMs: number;
  timeoutMessage: string;
  requestHeaders: Record<string, string>;
  body: Buffer;
  extraResponseHeaders: Record<string, string>;
  writeResponse?: boolean;
  deferRetryableStreamErrors?: boolean;
  maxBufferedResponseBytes?: number;
  maxObservedStreamEventBytes?: number;
}

export interface BufferedUpstreamResult {
  status: number;
  errorSummary: string | null;
  responseBody: Buffer;
  responseBodyTruncated: boolean;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
  streamSummary: OpenAiStreamSummary | null;
  clientDisconnectPhase: ClientDisconnectPhase;
}

export type UpstreamFailureKind =
  | "client_cancel"
  | "upstream_stream_incomplete"
  | "upstream_request_error"
  | "timeout";

export interface UpstreamFailureDetails {
  status: number | null;
  responseBody: Buffer;
  responseBodyTruncated: boolean;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
  streamSummary: OpenAiStreamSummary | null;
  clientDisconnectPhase: ClientDisconnectPhase;
  kind: UpstreamFailureKind;
}

export class UpstreamRequestError extends Error {
  constructor(
    message: string,
    readonly details: UpstreamFailureDetails
  ) {
    super(message);
    this.name = "UpstreamRequestError";
  }
}

const DEFERRED_RESPONSE_BUFFER_LIMIT_ERROR =
  "Upstream response exceeded the internal buffer limit before it could be forwarded.";

export interface OpenAiUpstreamOptions extends BufferedUpstreamOptions {
  retryEmptyStreamError?: boolean;
}

export function sendBufferedUpstreamRequest(
  options: BufferedUpstreamOptions
): Promise<BufferedUpstreamResult> {
  const client = options.upstream.protocol === "https:" ? https : http;
  const headers = { ...options.requestHeaders };
  headers["content-length"] = String(options.body.byteLength);
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  delete headers["transfer-encoding"];

  return new Promise((resolve, reject) => {
    let settled = false;
    let upstreamReq: http.ClientRequest | null = null;
    let activeResponse: ActiveUpstreamResponse | null = null;

    const cleanup = () => {
      options.res.off("close", handleClientClose);
      options.res.off("error", handleClientError);
      upstreamReq?.off("timeout", handleTimeout);
    };

    const resolveOnce = (result: BufferedUpstreamResult) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const responseDetails = (
      kind: UpstreamFailureKind,
      clientDisconnectPhase: ClientDisconnectPhase
    ): UpstreamFailureDetails => ({
      status: activeResponse?.status ?? null,
      responseBody: activeResponse ? Buffer.concat(activeResponse.responseChunks) : Buffer.alloc(0),
      responseBodyTruncated: activeResponse?.responseBodyTruncated ?? false,
      responseHeaders: activeResponse?.response.headers ?? {},
      firstTokenMs: activeResponse?.firstTokenMs ?? null,
      streamSummary: activeResponse?.streamObserver?.snapshot() ?? null,
      clientDisconnectPhase,
      kind
    });

    function handleClientClose() {
      if (options.res.writableEnded || settled) {
        return;
      }

      if (activeResponse?.responseResolutionStarted) {
        return;
      }

      if (settleAfterTerminal()) {
        return;
      }

      const details = responseDetails(
        "client_cancel",
        activeResponse ? "before_terminal" : "before_headers"
      );
      const error = new UpstreamRequestError(
        "Client disconnected before upstream response completed.",
        details
      );
      upstreamReq?.destroy();
      rejectOnce(error);
    }

    function handleClientError(error: Error) {
      upstreamReq?.destroy();
      rejectOnce(new UpstreamRequestError(error.message, responseDetails("client_cancel", "none")));
    }

    function handleTimeout() {
      const error = new UpstreamRequestError(
        options.timeoutMessage,
        responseDetails("timeout", activeResponse ? "before_terminal" : "before_headers")
      );
      upstreamReq?.destroy(error);
      rejectOnce(error);
    }

    function handleUpstreamRequestError(error: Error) {
      rejectOnce(new UpstreamRequestError(error.message, responseDetails("upstream_request_error", "none")));
    }

    function handleUpstreamResponseAborted() {
      if (settleAfterTerminal()) {
        return;
      }
      rejectOnce(new UpstreamRequestError(
        "Upstream response aborted before completion.",
        responseDetails("upstream_stream_incomplete", "before_terminal")
      ));
    }

    function handleUpstreamResponseError(error: Error) {
      if (settleAfterTerminal()) {
        return;
      }
      rejectOnce(new UpstreamRequestError(
        error.message,
        responseDetails("upstream_stream_incomplete", "before_terminal")
      ));
    }

    const requestOptions: RequestOptions = {
      method: options.req.method,
      headers,
      timeout: options.timeoutMs
    };
    const agent = resolveUpstreamAgent(options.upstream);
    if (agent) {
      requestOptions.agent = agent;
    }

    upstreamReq = client.request(
      options.upstream,
      requestOptions,
      (response) => {
        const status = response.statusCode ?? 502;
        const responseChunks: Buffer[] = [];
        let bufferedBytes = 0;
        let responseBodyTruncated = false;
        let firstTokenMs: number | null = null;
        const streamObserver = createOpenAiStreamObserver(response.headers, {
          maxEventBytes: normalizeMaxObservedStreamEventBytes(options.maxObservedStreamEventBytes)
        });
      const responseState: ActiveUpstreamResponse = {
          response,
          status,
          responseChunks,
          responseBodyTruncated: false,
          firstTokenMs: null,
          streamObserver,
          clientDisconnectPhase: "none",
          responseResolutionStarted: false
        };
        activeResponse = responseState;
        const shouldWriteResponse =
          options.writeResponse !== false &&
          !(options.deferRetryableStreamErrors === true && status >= 500);
        const shouldDeferRetryableResponse =
          options.deferRetryableStreamErrors === true && status >= 500;
        const maxBufferedResponseBytes = shouldWriteResponse || shouldDeferRetryableResponse
          ? normalizeMaxBufferedResponseBytes(options.maxBufferedResponseBytes)
          : Number.POSITIVE_INFINITY;
        if (shouldWriteResponse) {
          copyResponseHeaders(response.headers, options.res);
          for (const [name, value] of Object.entries(options.extraResponseHeaders)) {
            options.res.setHeader(name, value);
          }
          options.res.writeHead(status);
        }
        response.on("data", (chunk: Buffer) => {
          firstTokenMs ??= Math.max(0, Math.round(performance.now() - options.startedAt));
          responseState.firstTokenMs = firstTokenMs;
          const previousBufferedBytes = bufferedBytes;
          bufferedBytes = appendBufferedResponseChunk(
            responseChunks,
            bufferedBytes,
            chunk,
            maxBufferedResponseBytes
          );
          if (bufferedBytes - previousBufferedBytes < chunk.byteLength) {
            responseBodyTruncated = true;
            responseState.responseBodyTruncated = true;
          }
          streamObserver?.observe(chunk);
          if (shouldDeferRetryableResponse && responseBodyTruncated) {
            beginResolveUpstreamResponse();
            upstreamReq?.destroy();
            response.destroy();
          }
        });
        response.on("aborted", () => {
          if (!responseState.responseResolutionStarted) {
            handleUpstreamResponseAborted();
          }
        });
        response.on("error", (error) => {
          if (!responseState.responseResolutionStarted) {
            handleUpstreamResponseError(error);
          }
        });
        if (shouldWriteResponse) {
          response.pipe(options.res);
        }

        response.on("end", () => {
          beginResolveUpstreamResponse();
        });

        function beginResolveUpstreamResponse() {
          if (responseState.responseResolutionStarted) {
            return;
          }
          responseState.responseResolutionStarted = true;
          void resolveUpstreamResponse(responseState);
        }
      }
    );

    async function resolveUpstreamResponse(responseState: ActiveUpstreamResponse) {
      const responseBody = Buffer.concat(responseState.responseChunks);
      const streamSummary = responseState.streamObserver
        ? await responseState.streamObserver.finish()
        : null;
      resolveOnce({
        status: responseState.status,
        errorSummary: extractResponseErrorSummary(
          responseState.status,
          responseBody,
          responseState.response.headers
        ),
        responseBody,
        responseBodyTruncated: responseState.responseBodyTruncated,
        responseHeaders: responseState.response.headers,
        firstTokenMs: responseState.firstTokenMs,
        streamSummary,
        clientDisconnectPhase: responseState.clientDisconnectPhase
      });
    }

    function settleAfterTerminal(): boolean {
      const responseState = activeResponse;
      if (
        !responseState ||
        responseState.responseResolutionStarted ||
        !hasTerminalStream(responseState.streamObserver?.snapshot() ?? null)
      ) {
        return false;
      }

      responseState.clientDisconnectPhase = "after_terminal";
      responseState.responseResolutionStarted = true;
      upstreamReq?.destroy();
      void resolveUpstreamResponse(responseState);
      return true;
    }

    options.res.once("close", handleClientClose);
    options.res.once("error", handleClientError);
    upstreamReq.once("timeout", handleTimeout);
    upstreamReq.once("error", handleUpstreamRequestError);

    upstreamReq.end(options.body);
  });
}

interface ActiveUpstreamResponse {
  response: IncomingMessage;
  status: number;
  responseChunks: Buffer[];
  responseBodyTruncated: boolean;
  firstTokenMs: number | null;
  streamObserver: ReturnType<typeof createOpenAiStreamObserver>;
  clientDisconnectPhase: ClientDisconnectPhase;
  responseResolutionStarted: boolean;
}

function hasTerminalStream(summary: OpenAiStreamSummary | null): boolean {
  return Boolean(summary?.sawTerminalEvent);
}

export async function sendOpenAiUpstreamRequest(
  options: OpenAiUpstreamOptions
): Promise<BufferedUpstreamResult> {
  if (options.retryEmptyStreamError !== true) {
    return sendBufferedUpstreamRequest(options);
  }

  const firstResult = await sendBufferedUpstreamRequest({
    ...options,
    deferRetryableStreamErrors: true
  });

  if (!isRetryableEmptyStreamUpstreamError(firstResult)) {
    const finalResult = firstResult.responseBodyTruncated
      ? buildDeferredBufferLimitResult(firstResult)
      : firstResult;
    writeDeferredUpstreamResult(options.res, finalResult, options.extraResponseHeaders);
    return finalResult;
  }

  const retryResult = await sendBufferedUpstreamRequest(options);
  if (retryResult.errorSummary) {
    retryResult.errorSummary = `${retryResult.errorSummary} (retried after empty upstream stream)`;
  }

  return retryResult;
}

function buildDeferredBufferLimitResult(result: BufferedUpstreamResult): BufferedUpstreamResult {
  const responseBody = Buffer.from(JSON.stringify({
    error: DEFERRED_RESPONSE_BUFFER_LIMIT_ERROR
  }, null, 2));
  return {
    ...result,
    status: 502,
    errorSummary: DEFERRED_RESPONSE_BUFFER_LIMIT_ERROR,
    responseBody,
    responseBodyTruncated: true,
    responseHeaders: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(responseBody.byteLength)
    }
  };
}

export function summarizeOpenAiStreamFailure(result: BufferedUpstreamResult): string | null {
  if (result.status < 200 || result.status >= 300) {
    return null;
  }

  if (!result.streamSummary) {
    return "OpenAI stream response was not text/event-stream.";
  }

  const summary = result.streamSummary;
  if (summary.sawCompletedEvent || summary.sawDoneMarker) {
    return null;
  }

  if (summary.sawFailedEvent) {
    return "OpenAI stream ended with response.failed.";
  }

  if (summary.sawIncompleteEvent) {
    return "OpenAI stream ended with response.incomplete.";
  }

  if (summary.sawOutputEvent) {
    return "OpenAI stream closed before response.completed.";
  }

  return summary.eventCount > 0
    ? "OpenAI stream ended without response.completed, [DONE], or output token."
    : "OpenAI stream closed before response.completed.";
}

export function classifyOpenAiUpstreamResult(result: BufferedUpstreamResult): StreamOutcome {
  if (result.status >= 400) {
    return "upstream_http_error";
  }

  const summary = result.streamSummary;
  if (summary?.sawFailedEvent || summary?.sawIncompleteEvent) {
    return "upstream_stream_incomplete";
  }

  if (result.clientDisconnectPhase === "after_terminal") {
    return "success";
  }

  if (result.clientDisconnectPhase === "before_terminal") {
    return "client_cancel";
  }

  if (summary && !summary.sawCompletedEvent && !summary.sawDoneMarker) {
    return "upstream_stream_incomplete";
  }

  return "success";
}

function isRetryableEmptyStreamUpstreamError(result: BufferedUpstreamResult): boolean {
  if (result.status < 500) {
    return false;
  }

  const text = decodeBodyText(result.responseBody).toLowerCase();
  return (
    text.includes("upstream_stream_error") ||
    text.includes("stream disconnected before valid content") ||
    (text.includes("received 0 chars") && text.includes("content is insufficient"))
  );
}

function writeDeferredUpstreamResult(
  res: ServerResponse,
  result: BufferedUpstreamResult,
  extraResponseHeaders: Record<string, string>
): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }

  copyResponseHeaders(result.responseHeaders, res);
  for (const [name, value] of Object.entries(extraResponseHeaders)) {
    res.setHeader(name, value);
  }
  res.writeHead(result.status);
  res.end(result.responseBody);
}
