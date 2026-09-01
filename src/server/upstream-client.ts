import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse
} from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { copyResponseHeaders, decodeBodyText } from "./http-utils.js";
import {
  createAnthropicStreamObserver,
  createOpenAiStreamObserver,
  type OpenAiStreamSummary
} from "./upstream-openai-stream.js";
import { resolveUpstreamAgent } from "./upstream-proxy-agent.js";
import {
  appendBufferedResponseChunk,
  normalizeMaxBufferedResponseBytes,
  normalizeMaxObservedStreamEventBytes
} from "./upstream-response-buffer.js";
import { extractResponseErrorSummary } from "./usage.js";
import type { ClientDisconnectPhase, StreamOutcome } from "../shared/types.js";

export interface BufferedUpstreamOptions {
  req: IncomingMessage;
  res: ServerResponse;
  upstream: URL;
  startedAt: number;
  timeoutMs: number;
  timeoutMessage: string;
  requestHeaders: Record<string, string>;
  proxyUrl?: string;
  body: Buffer;
  extraResponseHeaders: Record<string, string>;
  writeResponse?: boolean;
  deferHttpErrors?: boolean;
  deferRetryableStreamErrors?: boolean;
  maxBufferedResponseBytes?: number;
  maxDeferredHttpErrorBytes?: number;
  maxObservedStreamEventBytes?: number;
  streamProtocol?: "openai" | "anthropic";
  responseTransform?: (status: number, headers: IncomingHttpHeaders) => UpstreamResponseTransform | null;
}

export interface UpstreamResponseTransform {
  stream: Duplex;
  responseHeaders: IncomingHttpHeaders;
  streamProtocol: "openai" | "anthropic";
  /**
   * Set by the transform when it could not translate the upstream body and emitted
   * a fallback error envelope instead. The envelope keeps the client from seeing a
   * dropped socket, but the request still failed: without this the failure would be
   * invisible to the log and — on a 2xx status, where nothing else marks it — would
   * reach failover as a *success*, resetting the profile's failure counters and
   * reinforcing stickiness onto an upstream that just returned garbage.
   */
  translationError?: string;
}

export interface BufferedUpstreamResult {
  status: number;
  errorSummary: string | null;
  responseBody: Buffer;
  responseBodyTruncated: boolean;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
  streamSummary: OpenAiStreamSummary | null;
  clientStreamSummary?: OpenAiStreamSummary | null;
  clientResponseBody?: Buffer | null;
  clientResponseHeaders?: IncomingHttpHeaders | null;
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
  retryHttpStatuses?: readonly number[];
  maxHttpStatusRetries?: number;
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
    const agent = resolveUpstreamAgent(options.upstream, options.proxyUrl);
    if (agent) {
      requestOptions.agent = agent;
    }

    upstreamReq = client.request(
      options.upstream,
      requestOptions,
      (response) => {
        const status = response.statusCode ?? 502;
        const responseChunks: Buffer[] = [];
        const shouldDeferHttpError = options.deferHttpErrors === true && status >= 400;
        const shouldDeferRetryableResponse =
          options.deferRetryableStreamErrors === true && status >= 500;
        const shouldDeferResponse = shouldDeferHttpError || shouldDeferRetryableResponse;
        const shouldWriteResponse = options.writeResponse !== false && !shouldDeferResponse;
        const maxBufferedResponseBytes = shouldDeferHttpError
          ? normalizeMaxBufferedResponseBytes(options.maxDeferredHttpErrorBytes)
          : options.writeResponse === false || shouldWriteResponse || shouldDeferRetryableResponse
            ? normalizeMaxBufferedResponseBytes(options.maxBufferedResponseBytes)
            : Number.POSITIVE_INFINITY;
        let responseTransform: UpstreamResponseTransform | null = null;
        try {
          responseTransform = shouldWriteResponse
            ? options.responseTransform?.(status, response.headers) ?? null
            : null;
        } catch (error) {
          response.resume();
          rejectOnce(new UpstreamRequestError(
            error instanceof Error ? error.message : "Upstream response transform failed.",
            responseDetails("upstream_request_error", "before_headers")
          ));
          return;
        }
        const clientResponseChunks: Buffer[] = [];
        let clientResponseBytes = 0;
        const clientStreamObserver = responseTransform
          ? responseTransform.streamProtocol === "anthropic"
            ? createAnthropicStreamObserver(responseTransform.responseHeaders)
            : createOpenAiStreamObserver(responseTransform.responseHeaders)
          : null;
        let responseTransformCompletion: Promise<void> | null = null;
        if (responseTransform) {
          responseTransform.stream.on("data", (chunk: Buffer) => {
            clientResponseBytes += chunk.byteLength;
            if (clientResponseBytes <= maxBufferedResponseBytes) {
              clientResponseChunks.push(Buffer.from(chunk));
            }
            clientStreamObserver?.observe(chunk);
          });
          responseTransformCompletion = new Promise<void>((resolve, reject) => {
            responseTransform.stream.once("end", resolve);
            responseTransform.stream.once("error", reject);
          });
          responseTransform.stream.once("error", (error) => {
            response.destroy(error);
          });
        }
        let bufferedBytes = 0;
        const streamObserver = options.streamProtocol === "anthropic"
          ? createAnthropicStreamObserver(response.headers, {
              maxEventBytes: normalizeMaxObservedStreamEventBytes(options.maxObservedStreamEventBytes)
            })
          : createOpenAiStreamObserver(response.headers, {
              maxEventBytes: normalizeMaxObservedStreamEventBytes(options.maxObservedStreamEventBytes)
            });
        const responseState: ActiveUpstreamResponse = {
          response,
          status,
          responseChunks,
          responseBodyTruncated: false,
          firstTokenMs: null,
          streamObserver,
          clientStreamObserver,
          clientResponseChunks,
          responseTransform,
          responseTransformCompletion,
          clientDisconnectPhase: "none",
          responseResolutionStarted: false
        };
        activeResponse = responseState;
        if (shouldWriteResponse) {
          copyResponseHeaders(responseTransform?.responseHeaders ?? response.headers, options.res);
          for (const [name, value] of Object.entries(options.extraResponseHeaders)) {
            options.res.setHeader(name, value);
          }
          options.res.writeHead(status);
        }
        response.on("data", (chunk: Buffer) => {
          responseState.firstTokenMs ??= Math.max(0, Math.round(performance.now() - options.startedAt));
          const previousBufferedBytes = bufferedBytes;
          bufferedBytes = appendBufferedResponseChunk(
            responseChunks,
            bufferedBytes,
            chunk,
            maxBufferedResponseBytes
          );
          if (bufferedBytes - previousBufferedBytes < chunk.byteLength) {
            responseState.responseBodyTruncated = true;
          }
          streamObserver?.observe(chunk);
          if ((shouldDeferResponse || options.writeResponse === false) && responseState.responseBodyTruncated) {
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
          if (responseTransform) {
            response.pipe(responseTransform.stream).pipe(options.res);
          } else {
            response.pipe(options.res);
          }
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
      if (responseState.responseTransformCompletion) {
        try {
          await responseState.responseTransformCompletion;
        } catch (error) {
          rejectOnce(new UpstreamRequestError(
            error instanceof Error ? error.message : "Upstream response transform failed.",
            responseDetails("upstream_stream_incomplete", "before_terminal")
          ));
          return;
        }
      }
      const streamSummary = responseState.streamObserver
        ? await responseState.streamObserver.finish()
        : null;
      const translationError = responseState.responseTransform?.translationError ?? null;
      resolveOnce({
        status: responseState.status,
        errorSummary: extractResponseErrorSummary(
          responseState.status,
          responseBody,
          responseState.response.headers
        ) ?? translationError,
        responseBody,
        responseBodyTruncated: responseState.responseBodyTruncated,
        responseHeaders: responseState.response.headers,
        firstTokenMs: responseState.firstTokenMs,
        streamSummary,
        clientStreamSummary: responseState.clientStreamObserver
          ? await responseState.clientStreamObserver.finish()
          : null,
        clientResponseBody: responseState.responseTransform
          ? Buffer.concat(responseState.clientResponseChunks)
          : null,
        clientResponseHeaders: responseState.responseTransform?.responseHeaders ?? null,
        clientDisconnectPhase: responseState.clientDisconnectPhase
      });
    }

    function settleAfterTerminal(): boolean {
      const responseState = activeResponse;
      if (
        !responseState ||
        responseState.responseResolutionStarted ||
        !responseState.streamObserver?.snapshot().sawTerminalEvent
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
  clientStreamObserver: ReturnType<typeof createOpenAiStreamObserver>;
  clientResponseChunks: Buffer[];
  responseTransform: UpstreamResponseTransform | null;
  responseTransformCompletion: Promise<void> | null;
  clientDisconnectPhase: ClientDisconnectPhase;
  responseResolutionStarted: boolean;
}

export async function sendOpenAiUpstreamRequest(
  options: OpenAiUpstreamOptions
): Promise<BufferedUpstreamResult> {
  const retryStatuses = new Set(options.retryHttpStatuses ?? []);
  const maxStatusRetries = Math.max(0, Math.floor(options.maxHttpStatusRetries ?? 0));
  // `timeoutMs` is the budget for the whole request, not for one attempt. Passing
  // it unchanged to each of the up-to-four attempts below turned a 900 s compact
  // timeout into a connection held for an hour. `sendRecoveringPrimaryRequest`
  // already spends the budget this way; the retry loop simply had not.
  const remainingTimeoutMs = () =>
    Math.max(1, options.timeoutMs - Math.round(performance.now() - options.startedAt));

  if (retryStatuses.size > 0 && maxStatusRetries > 0) {
    for (let retry = 0; retry < maxStatusRetries; retry += 1) {
      const result = await sendBufferedUpstreamRequest({
        ...options,
        timeoutMs: remainingTimeoutMs(),
        deferRetryableStreamErrors: true
      });
      if (retryStatuses.has(result.status) && !result.responseBodyTruncated) {
        continue;
      }

      const finalResult = result.responseBodyTruncated
        ? buildDeferredBufferLimitResult(result)
        : result;
      // ponytail: a deferred 5xx is written raw, so a non-retryable upstream
      // error (Anthropic's 529, for one) reaches a Codex client in the
      // upstream's own error shape while a retried 502 arrives translated.
      // Routing it through options.responseTransform means driving a Duplex
      // over an already-buffered body and needs a fallback for transforms that
      // only handle success shapes — worth doing only alongside a test for the
      // error path, since getting it wrong loses the error entirely.
      if (result.status >= 500) {
        writeBufferedUpstreamResult(options.res, finalResult, options.extraResponseHeaders);
      }
      return finalResult;
    }

    return sendBufferedUpstreamRequest({ ...options, timeoutMs: remainingTimeoutMs() });
  }

  if (options.retryEmptyStreamError !== true) {
    const result = await sendBufferedUpstreamRequest(options);
    return options.deferHttpErrors === true && result.status >= 400 && result.responseBodyTruncated
      ? buildDeferredBufferLimitResult(result)
      : result;
  }

  const firstResult = await sendBufferedUpstreamRequest({
    ...options,
    deferRetryableStreamErrors: true
  });

  if (!isRetryableEmptyStreamUpstreamError(firstResult)) {
    const finalResult = firstResult.responseBodyTruncated
      ? buildDeferredBufferLimitResult(firstResult)
      : firstResult;
    writeBufferedUpstreamResult(options.res, finalResult, options.extraResponseHeaders);
    return finalResult;
  }

  const retryResult = await sendBufferedUpstreamRequest({
    ...options,
    timeoutMs: remainingTimeoutMs()
  });
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

export function classifyAnthropicUpstreamResult(result: BufferedUpstreamResult): StreamOutcome {
  if (result.status >= 400) {
    return "upstream_http_error";
  }

  const summary = result.streamSummary;
  if (summary?.sawFailedEvent) {
    return "upstream_stream_error";
  }

  if (result.clientDisconnectPhase === "after_terminal") {
    return "success";
  }

  if (result.clientDisconnectPhase === "before_terminal") {
    return "client_cancel";
  }

  if (summary && !summary.sawCompletedEvent) {
    return "upstream_stream_incomplete";
  }

  return "success";
}

export function summarizeAnthropicStreamFailure(result: BufferedUpstreamResult): string | null {
  if (result.status < 200 || result.status >= 300 || !result.streamSummary) {
    return null;
  }

  const summary = result.streamSummary;
  if (summary.sawCompletedEvent) {
    return null;
  }

  if (summary.sawFailedEvent) {
    return summary.errorSummary ?? "Anthropic stream ended with an error event.";
  }

  if (summary.decodeError) {
    return "Anthropic stream could not be decoded for completion observation.";
  }

  return summary.eventCount > 0
    ? "Anthropic stream closed before message_stop."
    : "Anthropic stream ended without an observable event.";
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

export function writeBufferedUpstreamResult(
  res: ServerResponse,
  result: Pick<BufferedUpstreamResult, "status" | "responseHeaders" | "responseBody">,
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
