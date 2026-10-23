import { Agent as HttpAgent, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { parseHttpConnectProxyUrl } from "./upstream-proxy-url.js";

export type DrainOutcome = "complete" | "timeout" | "byte_limit" | "capacity" | "retired" | "closed" | "not_owned";

const httpsProxyAgents = new Map<string, HttpConnectHttpsAgent>();
const MAX_CACHED_PROXY_AGENTS = 8;
const MAX_IDLE_SOCKETS_PER_TARGET = 2;
const MAX_IDLE_SOCKETS_PER_AGENT = 8;
const IDLE_SOCKET_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_DRAIN_MS = 500;
const MAX_RESPONSE_DRAIN_BYTES = 64 * 1024;
const MAX_DRAINING_RESPONSES_PER_AGENT = 8;
let poolOwners = 0;

export function retainUpstreamProxyAgents(): () => void {
  poolOwners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Several in-process servers share this cache; only the last one retires it.
    if (--poolOwners !== 0) return;
    for (const agent of httpsProxyAgents.values()) agent.retire();
    httpsProxyAgents.clear();
  };
}

export const DEFAULT_MAX_PROXY_CONNECT_RESPONSE_HEADER_BYTES = 64 * 1024;
const CONNECT_HEADER_END = Buffer.from("\r\n\r\n", "latin1");

interface ConnectResponseHeaderRead {
  buffer: Buffer;
  headerEnd: number;
  remainingBuffers: Buffer[];
}

export interface UpstreamRequestOptions extends RequestOptions {
  // Node consumes its own signal before calling agent.createConnection.
  proxyConnectSignal?: AbortSignal;
}

export function resolveUpstreamAgent(
  upstream: URL,
  explicitProxyUrl = ""
): HttpAgent | HttpsAgent | undefined {
  if (upstream.protocol !== "https:") {
    if (explicitProxyUrl.trim().length > 0) {
      throw new Error("Explicit proxy configuration requires an HTTPS upstream.");
    }
    return undefined;
  }

  const proxy = resolveHttpsProxy(upstream, explicitProxyUrl);
  if (!proxy) {
    return undefined;
  }

  const key = proxy.toString();
  const cached = httpsProxyAgents.get(key);
  if (cached) {
    return cached;
  }
  const agent = new HttpConnectHttpsAgent(proxy);
  if (httpsProxyAgents.size >= MAX_CACHED_PROXY_AGENTS) {
    const oldest = httpsProxyAgents.keys().next().value;
    if (oldest !== undefined) {
      httpsProxyAgents.get(oldest)?.retire();
      httpsProxyAgents.delete(oldest);
    }
  }
  httpsProxyAgents.set(key, agent);
  return agent;
}

export function drainUpstreamResponse(
  agent: HttpAgent | HttpsAgent | undefined,
  response: IncomingMessage,
  remainingMs: number,
  onFinished?: (outcome: DrainOutcome, bytes: number) => void
): boolean {
  if (agent instanceof HttpConnectHttpsAgent) return agent.drainResponse(response, remainingMs, onFinished);
  onFinished?.("not_owned", 0);
  return false;
}

class HttpConnectHttpsAgent extends HttpsAgent {
  private retired = false;
  private readonly idleTimers = new Map<net.Socket, ReturnType<typeof setTimeout>>();
  private readonly drainingResponses = new Map<IncomingMessage, () => void>();

  constructor(private readonly proxy: URL) {
    super({ keepAlive: true, maxFreeSockets: MAX_IDLE_SOCKETS_PER_TARGET });
    this.on("free", (socket: net.Socket) => {
      // Node's listener runs first; queued requests must not receive an idle timer.
      if (!Object.values(this.freeSockets).some((sockets) => sockets?.includes(socket))) return;
      if (this.retired) { socket.destroy(); return; }
      this.clearIdleTimer(socket);
      if (this.idleTimers.size >= MAX_IDLE_SOCKETS_PER_AGENT) {
        const oldest = this.idleTimers.keys().next().value;
        if (oldest) { this.clearIdleTimer(oldest); oldest.destroy(); }
      }
      const timer = setTimeout(() => {
        this.idleTimers.delete(socket);
        socket.destroy();
      }, IDLE_SOCKET_TIMEOUT_MS);
      timer.unref();
      this.idleTimers.set(socket, timer);
    });
  }

  override reuseSocket(socket: net.Socket, request: ClientRequest): void {
    this.clearIdleTimer(socket);
    super.reuseSocket(socket, request);
  }

  private clearIdleTimer(socket: net.Socket): void {
    clearTimeout(this.idleTimers.get(socket));
    this.idleTimers.delete(socket);
  }

  drainResponse(response: IncomingMessage, remainingMs: number, onFinished?: (outcome: DrainOutcome, bytes: number) => void): boolean {
    const unavailable = this.retired ? "retired" : response.destroyed ? "closed" : remainingMs <= 0 ? "timeout"
      : this.drainingResponses.size >= MAX_DRAINING_RESPONSES_PER_AGENT ? "capacity" : null;
    if (unavailable) { onFinished?.(unavailable, 0); return false; }
    let bytes = 0;
    const finish = (outcome: DrainOutcome) => {
      if (!this.drainingResponses.delete(response)) return;
      clearTimeout(timer);
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("close", onClosed);
      response.off("error", onClosed);
      if (outcome !== "complete") response.destroy();
      onFinished?.(outcome, bytes);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_DRAIN_BYTES) finish("byte_limit");
    };
    const onEnd = () => finish(response.complete ? "complete" : "closed");
    const onClosed = () => finish("closed");
    const timer = setTimeout(() => finish("timeout"), Math.min(MAX_RESPONSE_DRAIN_MS, remainingMs));
    timer.unref();
    this.drainingResponses.set(response, () => finish("retired"));
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("close", onClosed);
    response.once("error", onClosed);
    response.resume();
    return true;
  }

  retire(): void {
    this.retired = true;
    // These requests have settled; only their bounded HTTP tails remain.
    for (const cancel of this.drainingResponses.values()) cancel();
    // The free listener closes retired sockets after the current response ends.
    for (const socket of this.idleTimers.keys()) {
      this.clearIdleTimer(socket);
      socket.destroy();
    }
  }

  override createConnection(
    options: UpstreamRequestOptions & { servername?: string },
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const targetHost = String(options.hostname ?? options.host ?? "");
    const targetPort = Number(options.port ?? 443);
    const proxyHost = this.proxy.hostname;
    const proxyPort = Number(this.proxy.port || 80);
    const proxySocket = net.connect(proxyPort, proxyHost);
    const complete = callback ?? (() => undefined);
    let responseBuffer: Buffer = Buffer.alloc(0);
    let completed = false;
    let tlsSocket: tls.TLSSocket | undefined;
    const signal = options.proxyConnectSignal;
    const timer = setTimeout(() => fail(new DOMException("Proxy CONNECT timed out.", "TimeoutError")), options.timeout || 30_000);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      tlsSocket?.off("error", fail);
      proxySocket.off("connect", handleConnect);
      proxySocket.off("data", handleData);
      proxySocket.off("error", handleProxyError);
      proxySocket.off("close", handleProxyClose);
    };

    const fail = (error: Error) => {
      if (completed) {
        return;
      }

      completed = true;
      cleanup();
      tlsSocket?.destroy();
      proxySocket.destroy();
      complete(error, proxySocket);
    };

    const succeed = (socket: tls.TLSSocket) => {
      if (completed) {
        return;
      }

      completed = true;
      cleanup();
      socket.once("close", () => this.clearIdleTimer(socket));
      complete(null, socket);
    };

    const handleConnect = () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        "Proxy-Connection: Keep-Alive"
      ];
      let auth: string | null;
      try {
        auth = proxyAuthorizationHeader(this.proxy);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Failed to decode proxy credentials."));
        return;
      }
      if (auth) {
        lines.push(`Proxy-Authorization: ${auth}`);
      }

      proxySocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    };

    const handleData = (chunk: Buffer) => {
      const nextHeader = appendConnectResponseHeaderBytes(responseBuffer, chunk);
      if (!nextHeader) {
        fail(new Error("Proxy CONNECT response header is too large."));
        return;
      }

      responseBuffer = nextHeader.buffer;
      if (nextHeader.headerEnd === -1) {
        return;
      }

      const headerEnd = nextHeader.headerEnd;
      const rawHeader = responseBuffer.subarray(0, headerEnd).toString("latin1");
      const statusLine = rawHeader.split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
        fail(new Error(`Proxy CONNECT failed: ${statusLine || "no status line"}`));
        return;
      }

      for (let index = nextHeader.remainingBuffers.length - 1; index >= 0; index -= 1) {
        const remaining = nextHeader.remainingBuffers[index];
        if (remaining.byteLength > 0) {
          proxySocket.unshift(remaining);
        }
      }

      proxySocket.off("data", handleData);
      proxySocket.off("error", handleProxyError);

      tlsSocket = tls.connect(
        {
          socket: proxySocket,
          servername: typeof options.servername === "string" ? options.servername : targetHost,
          ALPNProtocols: ["http/1.1"]
        },
        () => succeed(tlsSocket!)
      );
      tlsSocket.once("error", fail);
    };

    const handleProxyError = (error: Error) => {
      fail(error);
    };

    const handleProxyClose = () => {
      fail(new Error("Proxy CONNECT connection closed before response."));
    };

    const handleAbort = () => fail(new Error("Proxy CONNECT canceled."));

    proxySocket.once("connect", handleConnect);
    proxySocket.on("data", handleData);
    proxySocket.once("error", handleProxyError);
    proxySocket.once("close", handleProxyClose);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();

    return undefined;
  }
}

function appendConnectResponseHeaderBytes(previous: Buffer, chunk: Buffer): ConnectResponseHeaderRead | null {
  const maxBytes = DEFAULT_MAX_PROXY_CONNECT_RESPONSE_HEADER_BYTES;
  const remainingHeaderBytes = maxBytes - previous.byteLength;
  if (remainingHeaderBytes < 0) {
    return null;
  }

  const boundedChunk = chunk.subarray(0, Math.max(0, remainingHeaderBytes));
  const next =
    previous.byteLength === 0 ? Buffer.from(boundedChunk) : Buffer.concat([previous, boundedChunk]);
  const headerEnd = next.indexOf(CONNECT_HEADER_END);
  if (headerEnd !== -1) {
    const headerBytes = headerEnd + CONNECT_HEADER_END.byteLength;
    if (headerBytes > maxBytes) {
      return null;
    }

    return {
      buffer: next,
      headerEnd,
      remainingBuffers: [
        next.subarray(headerBytes),
        chunk.subarray(boundedChunk.byteLength)
      ]
    };
  }

  if (chunk.byteLength > boundedChunk.byteLength) {
    return null;
  }

  return {
    buffer: next,
    headerEnd: -1,
    remainingBuffers: []
  };
}

function resolveHttpsProxy(upstream: URL, explicitProxyUrl: string): URL | null {
  const explicit = explicitProxyUrl.trim();
  if (explicit) {
    return parseHttpConnectProxyUrl(explicit);
  }

  const configured =
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim();
  if (!configured || hostMatchesNoProxy(upstream)) {
    return null;
  }

  try {
    return parseHttpConnectProxyUrl(configured);
  } catch (error) {
    throw new Error(
      `HTTPS proxy environment is invalid: ${error instanceof Error ? error.message : "Invalid proxy URL."}`
    );
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

  const username = decodeProxyCredential(proxy.username);
  const password = decodeProxyCredential(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function decodeProxyCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("Proxy credentials contain malformed percent-encoding.");
  }
}
