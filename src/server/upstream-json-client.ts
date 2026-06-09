import http, { type RequestOptions } from "node:http";
import https from "node:https";
import { decodeBodyText } from "./http-utils.js";
import { resolveUpstreamAgent } from "./upstream-proxy-agent.js";
import { normalizeMaxJsonResponseBytes } from "./upstream-response-buffer.js";

export interface RequestJsonOptions {
  maxResponseBytes?: number;
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
