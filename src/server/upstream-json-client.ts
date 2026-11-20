import http from "node:http";
import https from "node:https";
import { decodeBodyText, readHeaderString } from "./http-utils.js";
import { decodeEncodedBody } from "./usage-utils.js";
import { resolveUpstreamAgent, type UpstreamRequestOptions } from "./upstream-proxy-agent.js";
import { MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES, normalizeMaxJsonResponseBytes } from "./upstream-response-buffer.js";

export interface RequestJsonOptions {
  maxResponseBytes?: number;
  proxyUrl?: string;
}

export function requestJson(
  upstream: URL,
  headers: Record<string, string>,
  timeoutMs: number,
  options: RequestJsonOptions = {}
): Promise<unknown> {
  const client = upstream.protocol === "https:" ? https : http;
  const connectionAbort = new AbortController();
  const requestOptions: UpstreamRequestOptions = {
    method: "GET",
    headers,
    proxyConnectSignal: connectionAbort.signal,
    timeout: timeoutMs
  };
  const agent = resolveUpstreamAgent(upstream, options.proxyUrl);
  if (agent) {
    requestOptions.agent = agent;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const maxResponseBytes = normalizeMaxJsonResponseBytes(options.maxResponseBytes);

    const resolveOnce = (value: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(deadlineTimer);
      resolve(value);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(deadlineTimer);
      connectionAbort.abort();
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
        if (status < 200 || status >= 300) {
          rejectOnce(new UpstreamStatusError(status, `Upstream JSON request failed with status ${status}.`));
          return;
        }

        try {
          const encoding = readHeaderString(response.headers["content-encoding"])?.trim().toLowerCase();
          let text: string;
          if (encoding && encoding !== "identity") {
            const decoded = decodeEncodedBody(body, encoding, MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES);
            if (!decoded) throw new Error(`Failed to decode upstream JSON response (${encoding}): invalid encoding or decoded body exceeds ${MAX_COMPLETE_UPSTREAM_RESPONSE_BYTES} bytes.`);
            text = decoded.toString("utf8");
          } else text = decodeBodyText(body);
          resolveOnce(JSON.parse(text) as unknown);
        } catch (error) {
          rejectOnce(error instanceof Error ? error : new Error("Failed to parse upstream JSON response."));
        }
      });
      response.once("error", rejectOnce);
      response.once("aborted", () => rejectOnce(new Error("Upstream JSON response aborted before completion.")));
    });

    upstreamReq.once("timeout", () => upstreamReq.destroy(new Error("Upstream JSON request timed out.")));
    upstreamReq.once("error", rejectOnce);
    deadlineTimer = setTimeout(() => upstreamReq.destroy(new Error("Upstream JSON request timed out.")), timeoutMs);
    upstreamReq.end();
  });
}

export class UpstreamStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
