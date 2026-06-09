import { Agent as HttpAgent, type RequestOptions } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

let cachedHttpsProxyAgentKey: string | null = null;
let cachedHttpsProxyAgent: HttpsAgent | null = null;

export const DEFAULT_MAX_PROXY_CONNECT_RESPONSE_HEADER_BYTES = 64 * 1024;
const CONNECT_HEADER_END = Buffer.from("\r\n\r\n", "latin1");

interface ConnectResponseHeaderRead {
  buffer: Buffer;
  headerEnd: number;
  remainingBuffers: Buffer[];
}

export function resolveUpstreamAgent(upstream: URL): HttpAgent | HttpsAgent | undefined {
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
    let responseBuffer: Buffer = Buffer.alloc(0);
    let completed = false;

    const cleanup = () => {
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

    const handleProxyClose = () => {
      fail(new Error("Proxy CONNECT connection closed before response."));
    };

    proxySocket.once("connect", handleConnect);
    proxySocket.on("data", handleData);
    proxySocket.once("error", handleProxyError);
    proxySocket.once("close", handleProxyClose);

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
