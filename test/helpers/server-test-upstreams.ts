import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { LOCALHOST_CERT, LOCALHOST_KEY } from "./server-tls.js";
import { cleanup, close, listen, trackServer } from "./server-test-lifecycle.js";

export async function startUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handler);
  await listen(server);
  trackServer(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`
  };
}

export async function startClaudeUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = http.createServer(handler);
  await listen(server);
  trackServer(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`
  };
}

export async function startHttpsClaudeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void
) {
  const server = https.createServer(
    {
      cert: LOCALHOST_CERT,
      key: LOCALHOST_KEY
    },
    handler
  );
  await listen(server);
  trackServer(server);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    url: `https://127.0.0.1:${address.port}`
  };
}

interface ConnectProxyOptions {
  closeBeforeConnectResponse?: boolean;
  extraConnectHeaderBytes?: number;
}

export async function startConnectProxy(options: ConnectProxyOptions = {}) {
  const connectTargets: string[] = [];
  const sockets = new Set<Duplex | net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end("CONNECT only");
  });

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.once("close", () => sockets.delete(clientSocket));

    const target = req.url ?? "";
    connectTargets.push(target);
    if (options.closeBeforeConnectResponse) {
      clientSocket.end();
      return;
    }

    const [host, rawPort] = target.split(":");
    const port = Number(rawPort);
    if (!host || !Number.isInteger(port)) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    const upstreamSocket = net.connect(port, host, () => {
      sockets.add(upstreamSocket);
      upstreamSocket.once("close", () => sockets.delete(upstreamSocket));
      const extraHeader =
        options.extraConnectHeaderBytes && options.extraConnectHeaderBytes > 0
          ? `X-CompactGate-Fill: ${"x".repeat(options.extraConnectHeaderBytes)}\r\n`
          : "";
      clientSocket.write(`HTTP/1.1 200 Connection Established\r\n${extraHeader}\r\n`);
      if (head.byteLength > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.once("error", () => {
      clientSocket.destroy();
    });
    clientSocket.once("error", () => {
      upstreamSocket.destroy();
    });
  });

  await listen(server);
  cleanup.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await close(server);
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return {
    connectTargets,
    url: `http://127.0.0.1:${address.port}`
  };
}
