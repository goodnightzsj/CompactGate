import fs from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUpstreamHeaders, copyResponseHeaders, sendJson } from "../src/server/http-utils.js";
import { serveStatic } from "../src/server/static-assets.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

describe("connection-specific headers", () => {
  it("removes Connection tokens in both directions while preserving trusted overrides", async () => {
    let received: http.IncomingHttpHeaders = {};
    const upstreamUrl = await listen(http.createServer((req, res) => {
      received = req.headers;
      res.writeHead(200, {
        connection: "close, X-Response-Hop",
        "x-response-hop": "must-not-forward",
        "x-response-end": "keep-response"
      });
      res.end("ok");
    }));
    const proxyUrl = await listen(http.createServer((req, res) => {
      const upstream = http.request(upstreamUrl, {
        headers: buildUpstreamHeaders(req.headers, "synthetic-key", { "x-trusted": "configured" })
      }, (response) => {
        copyResponseHeaders(response.headers, res);
        response.pipe(res);
      });
      upstream.on("error", (error) => res.destroy(error));
      req.pipe(upstream);
    }));
    const result = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const request = http.get(proxyUrl, { headers: {
        connection: "close, X-Request-Hop, x-trusted, authorization",
        "x-request-hop": "must-not-forward",
        "x-trusted": "untrusted",
        "x-request-end": "keep-request",
        authorization: "untrusted"
      } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
      });
      request.on("error", reject);
    });
    expect(received["x-request-hop"]).toBeUndefined();
    expect(received["x-request-end"]).toBe("keep-request");
    expect(received["x-trusted"]).toBe("configured");
    expect(received.authorization).toBe("Bearer synthetic-key");
    expect(result).toMatchObject({ status: 200, body: "ok" });
    expect(result.headers["x-response-hop"]).toBeUndefined();
    expect(result.headers["x-response-end"]).toBe("keep-response");
  });
});

async function staticFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-static-resource-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "dist/public/assets"), { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(dir);
  cleanups.push(async () => { process.chdir(previousCwd); });
  const errors: unknown[] = [];
  const url = await listen(http.createServer((req, res) => {
    void serveStatic(req, res, new URL(req.url ?? "/", "http://localhost")).catch((error: unknown) => {
      errors.push(error);
      sendJson(res, 500, { error: "Static read failed." });
    });
  }));
  return { dir, url, errors };
}

describe("static file stream ownership", () => {
  it.skipIf(process.getuid?.() === 0)("returns HTTP failure when an existing file cannot be opened", async () => {
    const { dir, url, errors } = await staticFixture();
    const target = path.join(dir, "dist/public/assets/unreadable.js");
    await writeFile(target, "unreadable");
    await chmod(target, 0);
    try {
      const response = await fetch(`${url}/assets/unreadable.js`, { signal: AbortSignal.timeout(1_000) });
      expect(response.status).toBe(500);
      expect(response.headers.get("cache-control")).toBeNull();
      expect(await response.json()).toEqual({ error: "Static read failed." });
      expect(errors).toHaveLength(1);
    } finally {
      await chmod(target, 0o600);
    }
  });

  it("destroys the file source when the client cancels a download", async () => {
    const { dir, url } = await staticFixture();
    const target = path.join(dir, "dist/public/assets/large.js");
    await writeFile(target, Buffer.alloc(16 * 1024 * 1024, 120));
    const createReadStream = fs.createReadStream;
    let source: fs.ReadStream | undefined;
    let sourceClosed: Promise<unknown> | undefined;
    cleanups.push(async () => { source?.destroy(); });
    vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
      source = createReadStream(...args);
      sourceClosed = new Promise<void>((resolve) => source?.once("close", resolve));
      return source;
    });
    syncBuiltinESMExports();
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${url}/assets/large.js`, (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    expect(source).toBeDefined();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sourceClosed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("File source was not closed after cancellation.")), 1_000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(source?.destroyed).toBe(true);
    expect(source?.bytesRead).toBeLessThan(16 * 1024 * 1024);
  });

  it("destroys a partial response when its open file stream fails", async () => {
    const { dir, url, errors } = await staticFixture();
    await writeFile(path.join(dir, "dist/public/assets/failing.js"), Buffer.alloc(16 * 1024 * 1024, 120));
    const createReadStream = fs.createReadStream;
    let source: fs.ReadStream | undefined;
    cleanups.push(async () => { source?.destroy(); });
    vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
      source = createReadStream(...args);
      source.once("data", () => setImmediate(() => source?.destroy(new Error("Synthetic read failure."))));
      return source;
    });
    syncBuiltinESMExports();
    const response = await fetch(`${url}/assets/failing.js`, { signal: AbortSignal.timeout(1_000) });
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(source?.destroyed).toBe(true);
    expect(errors).toEqual([expect.objectContaining({ message: "Synthetic read failure." })]);
  });

  it("keeps complete GET and HEAD responses and asset cache metadata", async () => {
    const { dir, url, errors } = await staticFixture();
    await writeFile(path.join(dir, "dist/public/assets/app.js"), "hello");
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${url}/assets/app.js`, { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("5");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await response.text()).toBe(method === "HEAD" ? "" : "hello");
    }
    expect(errors).toEqual([]);
  });
});
