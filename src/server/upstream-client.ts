import http, {
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse
} from "node:http";
import https, { Agent as HttpsAgent } from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { copyResponseHeaders, decodeBodyText } from "./http-utils.js";
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
}

export interface BufferedUpstreamResult {
  status: number;
  errorSummary: string | null;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
  firstTokenMs: number | null;
  streamSummary: OpenAiStreamSummary | null;
}

export interface OpenAiUpstreamOptions extends BufferedUpstreamOptions {
  retryEmptyStreamError?: boolean;
}

export interface OpenAiStreamSummary {
  sawTerminalEvent: boolean;
  sawCompletedEvent: boolean;
  sawFailedEvent: boolean;
  sawIncompleteEvent: boolean;
  sawOutputEvent: boolean;
  sawDoneMarker: boolean;
  eventCount: number;
}

let cachedHttpsProxyAgentKey: string | null = null;
let cachedHttpsProxyAgent: HttpsAgent | null = null;

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
        let firstTokenMs: number | null = null;
        const streamObserver = createOpenAiStreamObserver(response.headers);
        const shouldWriteResponse =
          options.writeResponse !== false &&
          !(options.deferRetryableStreamErrors === true && status >= 500);
        if (shouldWriteResponse) {
          copyResponseHeaders(response.headers, options.res);
          for (const [name, value] of Object.entries(options.extraResponseHeaders)) {
            options.res.setHeader(name, value);
          }
          options.res.writeHead(status);
        }
        response.on("data", (chunk: Buffer) => {
          firstTokenMs ??= Math.max(0, Math.round(performance.now() - options.startedAt));
          responseChunks.push(Buffer.from(chunk));
          streamObserver?.observe(chunk);
        });
        response.on("aborted", handleUpstreamResponseAborted);
        response.on("error", handleUpstreamResponseError);
        if (shouldWriteResponse) {
          response.pipe(options.res);
        }

        response.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          resolveOnce({
            status,
            errorSummary: extractResponseErrorSummary(status, responseBody, response.headers),
            responseBody,
            responseHeaders: response.headers,
            firstTokenMs,
            streamSummary: streamObserver?.finish() ?? null
          });
        });
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
    writeDeferredUpstreamResult(options.res, firstResult, options.extraResponseHeaders);
    return firstResult;
  }

  const retryResult = await sendBufferedUpstreamRequest(options);
  if (retryResult.errorSummary) {
    retryResult.errorSummary = `${retryResult.errorSummary} (retried after empty upstream stream)`;
  }

  return retryResult;
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
  timeoutMs: number
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
    const upstreamReq = client.request(upstream, requestOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        const status = response.statusCode ?? 502;
        if (status >= 400) {
          reject(new UpstreamStatusError(status, `Claude models request failed with status ${status}.`));
          return;
        }

        try {
          resolve(JSON.parse(body.toString("utf8")) as unknown);
        } catch (error) {
          reject(error);
        }
      });
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("Claude models response aborted before completion.")));
    });

    upstreamReq.once("timeout", () => upstreamReq.destroy(new Error("Claude models request timed out.")));
    upstreamReq.once("error", reject);
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

function createOpenAiStreamObserver(headers: IncomingHttpHeaders): OpenAiStreamObserver | null {
  const contentType = readHeader(headers["content-type"])?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream") ? new OpenAiStreamObserver() : null;
}

class OpenAiStreamObserver {
  private pending = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];
  private summary: OpenAiStreamSummary = {
    sawTerminalEvent: false,
    sawCompletedEvent: false,
    sawFailedEvent: false,
    sawIncompleteEvent: false,
    sawOutputEvent: false,
    sawDoneMarker: false,
    eventCount: 0
  };

  observe(chunk: Buffer): void {
    this.pending += chunk.toString("utf8");
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";

    for (const line of lines) {
      this.observeLine(line);
    }
  }

  finish(): OpenAiStreamSummary {
    if (this.pending.length > 0) {
      this.observeLine(this.pending);
      this.pending = "";
    }
    this.flushEvent();
    return { ...this.summary };
  }

  private observeLine(line: string): void {
    if (line === "") {
      this.flushEvent();
      return;
    }

    if (line.startsWith("event:")) {
      this.eventName = line.slice("event:".length).trim();
      return;
    }

    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  private flushEvent(): void {
    if (!this.eventName && this.dataLines.length === 0) {
      return;
    }

    this.summary.eventCount += 1;
    const data = this.dataLines.join("\n").trim();
    if (data === "[DONE]") {
      this.summary.sawDoneMarker = true;
      this.summary.sawTerminalEvent = true;
    }

    const eventType = this.readEventType(data);
    if (isOpenAiTerminalEvent(this.eventName) || isOpenAiTerminalEvent(eventType)) {
      this.summary.sawTerminalEvent = true;
    }
    if (isOpenAiCompletedEvent(this.eventName) || isOpenAiCompletedEvent(eventType)) {
      this.summary.sawCompletedEvent = true;
    }
    if (isOpenAiFailedEvent(this.eventName) || isOpenAiFailedEvent(eventType)) {
      this.summary.sawFailedEvent = true;
    }
    if (isOpenAiIncompleteEvent(this.eventName) || isOpenAiIncompleteEvent(eventType)) {
      this.summary.sawIncompleteEvent = true;
    }
    if (isOpenAiOutputEvent(this.eventName) || isOpenAiOutputEvent(eventType) || hasOpenAiOutputPayload(data)) {
      this.summary.sawOutputEvent = true;
    }

    this.eventName = null;
    this.dataLines = [];
  }

  private readEventType(data: string): string | null {
    if (!data || data === "[DONE]") {
      return null;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed) && typeof parsed.type === "string") {
        return parsed.type;
      }
    } catch {
      return null;
    }

    return null;
  }
}

function isOpenAiTerminalEvent(type: string | null): boolean {
  return type === "response.completed" || type === "response.failed" || type === "response.incomplete";
}

function isOpenAiCompletedEvent(type: string | null): boolean {
  return type === "response.completed";
}

function isOpenAiFailedEvent(type: string | null): boolean {
  return type === "response.failed";
}

function isOpenAiIncompleteEvent(type: string | null): boolean {
  return type === "response.incomplete";
}

function isOpenAiOutputEvent(type: string | null): boolean {
  if (!type) {
    return false;
  }

  return (
    type === "response.output_text.delta" ||
    type === "response.output_item.done" ||
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_summary_part.added" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta" ||
    type.endsWith(".delta")
  );
}

function hasOpenAiOutputPayload(data: string): boolean {
  if (!data || data === "[DONE]") {
    return false;
  }

  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) {
      return false;
    }

    const delta = parsed.delta;
    if (typeof delta === "string" && delta.length > 0) {
      return true;
    }

    if (Array.isArray(parsed.output) && parsed.output.length > 0) {
      return true;
    }

    const response = parsed.response;
    return isRecord(response) && Array.isArray(response.output) && response.output.length > 0;
  } catch {
    return false;
  }
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

function readHeader(value: IncomingHttpHeaders[string]): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpConnectHttpsAgent extends HttpsAgent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: RequestOptions & { servername?: string },
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const targetHost = String(options.hostname ?? options.host ?? "");
    const targetPort = Number(options.port ?? 443);
    const proxyHost = this.proxy.hostname;
    const proxyPort = Number(this.proxy.port || 80);
    const proxySocket = net.connect(proxyPort, proxyHost);
    const complete = callback ?? (() => undefined);
    let responseBuffer = Buffer.alloc(0);
    let completed = false;

    const cleanup = () => {
      proxySocket.off("connect", handleConnect);
      proxySocket.off("data", handleData);
      proxySocket.off("error", handleProxyError);
    };

    const fail = (error: Error) => {
      if (completed) {
        return;
      }

      completed = true;
      cleanup();
      proxySocket.destroy();
      complete(error, proxySocket);
    };

    const succeed = (socket: tls.TLSSocket) => {
      if (completed) {
        return;
      }

      completed = true;
      cleanup();
      complete(null, socket);
    };

    const handleConnect = () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        "Proxy-Connection: Keep-Alive"
      ];
      const auth = proxyAuthorizationHeader(this.proxy);
      if (auth) {
        lines.push(`Proxy-Authorization: ${auth}`);
      }

      proxySocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    };

    const handleData = (chunk: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const rawHeader = responseBuffer.subarray(0, headerEnd).toString("latin1");
      const statusLine = rawHeader.split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        fail(new Error(`Proxy CONNECT failed: ${statusLine || "no status line"}`));
        return;
      }

      const remaining = responseBuffer.subarray(headerEnd + 4);
      if (remaining.byteLength > 0) {
        proxySocket.unshift(remaining);
      }

      proxySocket.off("data", handleData);
      proxySocket.off("error", handleProxyError);

      const tlsSocket = tls.connect(
        {
          socket: proxySocket,
          servername: typeof options.servername === "string" ? options.servername : targetHost,
          ALPNProtocols: ["http/1.1"]
        },
        () => succeed(tlsSocket)
      );
      tlsSocket.once("error", fail);
    };

    const handleProxyError = (error: Error) => {
      fail(error);
    };

    proxySocket.once("connect", handleConnect);
    proxySocket.on("data", handleData);
    proxySocket.once("error", handleProxyError);

    return undefined;
  }
}

function resolveUpstreamAgent(upstream: URL): HttpAgent | HttpsAgent | undefined {
  if (upstream.protocol !== "https:") {
    return undefined;
  }

  const proxy = resolveHttpsProxy(upstream);
  if (!proxy) {
    return undefined;
  }

  const key = proxy.toString();
  if (cachedHttpsProxyAgentKey !== key || !cachedHttpsProxyAgent) {
    cachedHttpsProxyAgentKey = key;
    cachedHttpsProxyAgent = new HttpConnectHttpsAgent(proxy);
  }

  return cachedHttpsProxyAgent ?? undefined;
}

function resolveHttpsProxy(upstream: URL): URL | null {
  const configured =
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim();
  if (!configured || hostMatchesNoProxy(upstream)) {
    return null;
  }

  try {
    const proxy = new URL(configured);
    return proxy.protocol === "http:" ? proxy : null;
  } catch {
    return null;
  }
}

function hostMatchesNoProxy(upstream: URL): boolean {
  const configured = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const host = upstream.hostname.toLowerCase();
  const port = upstream.port || (upstream.protocol === "https:" ? "443" : "80");

  for (const rawPattern of configured.split(",")) {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) {
      continue;
    }

    if (pattern === "*") {
      return true;
    }

    const [patternHost, patternPort] = splitNoProxyPattern(pattern);
    if (patternPort && patternPort !== port) {
      continue;
    }

    if (patternHost.startsWith(".")) {
      const suffix = patternHost.slice(1);
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        return true;
      }
      continue;
    }

    if (host === patternHost || host.endsWith(`.${patternHost}`)) {
      return true;
    }
  }

  return false;
}

function splitNoProxyPattern(pattern: string): [host: string, port: string | null] {
  const index = pattern.lastIndexOf(":");
  if (index <= 0 || pattern.includes("]")) {
    return [pattern, null];
  }

  const possiblePort = pattern.slice(index + 1);
  if (!/^\d+$/.test(possiblePort)) {
    return [pattern, null];
  }

  return [pattern.slice(0, index), possiblePort];
}

function proxyAuthorizationHeader(proxy: URL): string | null {
  if (!proxy.username && !proxy.password) {
    return null;
  }

  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
