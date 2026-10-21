import https from "node:https";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  resolveUpstreamAgent, retainUpstreamProxyAgents, type UpstreamRequestOptions
} from "../src/server/upstream-proxy-agent.js";
import { parseHttpConnectProxyUrl } from "../src/server/upstream-proxy-url.js";

export async function measureUpstreamLatency(targetUrl: string, proxyUrl: string) {
  let target: URL;
  let proxy: URL;
  try {
    target = new URL(targetUrl);
    proxy = parseHttpConnectProxyUrl(proxyUrl);
  } catch (cause) {
    throw Object.assign(new Error("Invalid probe URL.", { cause }), { code: "PROBE_INVALID_URL" });
  }
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash || proxy.username || proxy.password) {
    throw Object.assign(new Error("Use a public HTTPS URL without credentials, query or fragment and an unauthenticated HTTP proxy."), { code: "PROBE_INVALID_URL" });
  }
  const release = retainUpstreamProxyAgents();
  const agent = resolveUpstreamAgent(target, proxy.toString());
  const samples = [];
  try {
    for (let run = 1; run <= 3; run++) {
      const startedAt = performance.now();
      const elapsed = () => performance.now() - startedAt;
      const abort = new AbortController();
      const deadline = setTimeout(() => abort.abort(), 10_000);
      let socketReadyMs = 0;
      let requestSentMs = 0;
      let firstBodyByteMs: number | null = null;
      let bytes = 0;
      try {
        samples.push(await new Promise<{
          run: number; status: number; reused_socket: boolean; socket_ready_ms: number;
          request_sent_ms: number; headers_ms: number; first_body_byte_ms: number | null;
          body_ms: number; total_ms: number; bytes: number;
        }>((resolve, reject) => {
          const options: UpstreamRequestOptions = {
            method: "GET", agent, signal: abort.signal, proxyConnectSignal: abort.signal, timeout: 10_000
          };
          const req = https.request(target, options, (res) => {
            const headersMs = elapsed();
            res.on("data", (chunk: Buffer) => {
              firstBodyByteMs ??= elapsed();
              bytes += chunk.byteLength;
              if (bytes > 1024 * 1024) req.destroy(Object.assign(new Error("Probe response exceeds 1 MiB."), { code: "PROBE_RESPONSE_TOO_LARGE" }));
            });
            res.once("error", reject);
            res.once("end", () => {
              const totalMs = elapsed();
              resolve({
                run, status: res.statusCode ?? 0, reused_socket: req.reusedSocket,
                socket_ready_ms: socketReadyMs, request_sent_ms: requestSentMs,
                headers_ms: headersMs, first_body_byte_ms: firstBodyByteMs,
                body_ms: totalMs - headersMs, total_ms: totalMs, bytes
              });
            });
          });
          req.once("socket", () => { socketReadyMs = elapsed(); });
          req.once("finish", () => { requestSentMs = elapsed(); });
          req.once("error", (error) => { abort.abort(); reject(error); });
          req.end();
        }));
      } finally {
        clearTimeout(deadline);
      }
      await nextTurn();
    }
    return samples;
  } finally {
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("Usage: npx tsx scripts/upstream-latency.ts <public-https-url> <http-proxy-url>");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await measureUpstreamLatency(args[0], args[1]), null, 2));
    } catch (error) {
      // Do not echo URLs, response bodies or upstream error messages containing credentials.
      const code = error instanceof Error && "code" in error ? String(error.code) : "ERROR";
      console.error(`Upstream latency probe failed (${/^[A-Z_0-9]+$/.test(code) ? code : "ERROR"}).`);
      process.exitCode = 1;
    }
  }
}
