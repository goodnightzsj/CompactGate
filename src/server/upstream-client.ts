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
import { extractResponseErrorSummary } from "./usage.js";

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
}

export const DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_JSON_RESPONSE_BYTES = 1 * 1024 * 1024;
export const DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES = 64 * 1024;
const DEFERRED_RESPONSE_BUFFER_LIMIT_ERROR =
  "Upstream response exceeded the internal buffer limit before it could be forwarded.";

export interface OpenAiUpstreamOptions extends BufferedUpstreamOptions {
  retryEmptyStreamError?: boolean;
}

export interface RequestJsonOptions {
  maxResponseBytes?: number;
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

    const clientDisconnectError = () =>
      new Error("Client disconnected before upstream response completed.");

    function handleClientClose() {
      if (options.res.writableEnded || settled) {
        return;
      }

      const error = clientDisconnectError();
      upstreamReq?.destroy();
      rejectOnce(error);
    }

    function handleClientError(error: Error) {
      upstreamReq?.destroy();
      rejectOnce(error);
    }

    function handleTimeout() {
      upstreamReq?.destroy(new Error(options.timeoutMessage));
    }

    function handleUpstreamRequestError(error: Error) {
      rejectOnce(error);
    }

    function handleUpstreamResponseAborted() {
      rejectOnce(new Error("Upstream response aborted before completion."));
    }

    function handleUpstreamResponseError(error: Error) {
      rejectOnce(error);
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
          const previousBufferedBytes = bufferedBytes;
          bufferedBytes = appendBufferedResponseChunk(
            responseChunks,
            bufferedBytes,
            chunk,
            maxBufferedResponseBytes
          );
          if (bufferedBytes - previousBufferedBytes < chunk.byteLength) {
            responseBodyTruncated = true;
          }
          streamObserver?.observe(chunk);
          if (shouldDeferRetryableResponse && responseBodyTruncated) {
            resolveUpstreamResponse();
            upstreamReq?.destroy();
            response.destroy();
          }
        });
        response.on("aborted", handleUpstreamResponseAborted);
        response.on("error", handleUpstreamResponseError);
        if (shouldWriteResponse) {
          response.pipe(options.res);
        }

        response.on("end", () => {
          resolveUpstreamResponse();
        });

        function resolveUpstreamResponse() {
          const responseBody = Buffer.concat(responseChunks);
          resolveOnce({
            status,
            errorSummary: extractResponseErrorSummary(status, responseBody, response.headers),
            responseBody,
            responseBodyTruncated,
            responseHeaders: response.headers,
            firstTokenMs,
            streamSummary: streamObserver?.finish() ?? null
          });
        }
      }
    );

    options.res.once("close", handleClientClose);
    options.res.once("error", handleClientError);
    upstreamReq.once("timeout", handleTimeout);
    upstreamReq.once("error", handleUpstreamRequestError);

    upstreamReq.end(options.body);
  });
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

export function requestJson(
  upstream: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  options: RequestJsonOptions = {}
): Promise<unknown> {
  const client = upstream.protocol === "https:" ? https : http;
  const requestOptions: RequestOptions = {
    method: "GET",
    headers,
    timeout: timeoutMs
  };
  const agent = resolveUpstreamAgent(upstream);
  if (agent) {
    requestOptions.agent = agent;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const maxResponseBytes = normalizeMaxJsonResponseBytes(options.maxResponseBytes);

    const resolveOnce = (value: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    };

    const upstreamReq = client.request(upstream, requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on("data", (chunk: Buffer) => {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxResponseBytes) {
          rejectOnce(new Error("Upstream JSON response is too large."));
          upstreamReq.destroy();
          response.destroy();
          return;
        }

        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) {
          return;
        }

        const body = Buffer.concat(chunks);
        const status = response.statusCode ?? 502;
        if (status >= 400) {
          rejectOnce(new UpstreamStatusError(status, `Claude models request failed with status ${status}.`));
          return;
        }

        try {
          resolveOnce(JSON.parse(decodeBodyText(body)) as unknown);
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error("Failed to parse upstream JSON response."));
        }
      });
      response.once("error", rejectOnce);
      response.once("aborted", () => rejectOnce(new Error("Claude models response aborted before completion.")));
    });

    upstreamReq.once("timeout", () => upstreamReq.destroy(new Error("Claude models request timed out.")));
    upstreamReq.once("error", rejectOnce);
    upstreamReq.end();
  });
}

export class UpstreamStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
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

function appendBufferedResponseChunk(
  chunks: Buffer[],
  bufferedBytes: number,
  chunk: Buffer,
  maxBufferedBytes: number
): number {
  if (chunk.byteLength === 0 || bufferedBytes >= maxBufferedBytes) {
    return bufferedBytes;
  }

  if (!Number.isFinite(maxBufferedBytes)) {
    chunks.push(Buffer.from(chunk));
    return bufferedBytes + chunk.byteLength;
  }

  const remainingBytes = maxBufferedBytes - bufferedBytes;
  const bytesToCopy = Math.min(remainingBytes, chunk.byteLength);
  if (bytesToCopy > 0) {
    chunks.push(Buffer.from(chunk.subarray(0, bytesToCopy)));
  }

  return bufferedBytes + bytesToCopy;
}

function normalizeMaxBufferedResponseBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_BUFFERED_UPSTREAM_RESPONSE_BYTES;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeMaxJsonResponseBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_JSON_RESPONSE_BYTES;
  }

  return Math.max(0, Math.floor(value));
}

function normalizeMaxObservedStreamEventBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_OBSERVED_STREAM_EVENT_BYTES;
  }

  return Math.max(0, Math.floor(value));
}
