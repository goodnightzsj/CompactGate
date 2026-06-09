import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  CompactGateConfig,
  RequestTransport,
  RouteKind
} from "../shared/types.js";
import type { ConfigStore } from "./config.js";
import {
  buildAnthropicUpstreamHeaders,
  buildClaudeUpstreamUrl,
  resolveClaudeCredential,
  resolveClaudeMappedModel,
  rewriteClaudeModelBody
} from "./claude-models.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import { serializeHeaders } from "./debug-capture.js";
import {
  copyResponseHeaders,
  endpointFromPath,
  RequestBodyTooLargeError,
  readRawBody,
  sendJson,
  summaryForError
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import { addLog, emptyUsageMetrics, persistCapture } from "./proxy-support.js";
import { StudioEventBroadcaster } from "./studio-events.js";
import {
  extractRequestMetadata,
  extractResponseUsage,
  extractSourceModel,
  responseTransport,
  type RequestMetadata,
  type TokenUsageMetrics
} from "./usage.js";
import {
  sendBufferedUpstreamRequest,
  type BufferedUpstreamResult
} from "./upstream-client.js";

export const ANTHROPIC_PROXY_PREFIX = "/anthropic";
export { fetchClaudeModels, type FetchClaudeModels } from "./claude-models.js";

export async function proxyClaudeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster
): Promise<void> {
  const startedAt = performance.now();
  const config = configStore.get();
  const route: RouteKind = "claude";
  const requestId = randomUUID();
  const upstreamPath = stripAnthropicProxyPrefix(url.pathname);
  let upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
  let requestHeaders: Record<string, string> = {};
  let upstreamBody: Buffer = Buffer.alloc(0);
  let status = 502;
  let errorSummary: string | null = null;
  let rawBody: Buffer = Buffer.alloc(0);
  let responseBody: Buffer = Buffer.alloc(0);
  let responseHeaders: IncomingHttpHeaders = {};
  let requestMetadata: RequestMetadata | null = null;
  let requestType: RequestTransport = "http";
  let firstTokenMs: number | null = null;
  let sourceModel: string | null = null;
  let targetModel: string | null = null;
  let usage: TokenUsageMetrics = emptyUsageMetrics();

  try {
    rawBody = await readRawBody(req, 100 * 1024 * 1024);
    requestMetadata = extractRequestMetadata(upstreamPath, rawBody);
    requestType = requestMetadata.requestType;
    sourceModel = extractSourceModel(rawBody);
    targetModel = resolveClaudeMappedModel(sourceModel, config) ?? sourceModel;
    upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
    upstreamBody = rewriteClaudeModelBody(rawBody, targetModel ?? "");
    const auth = resolveClaudeCredential(config);
    requestHeaders = buildAnthropicUpstreamHeaders(req.headers, auth.apiKey);
    if (upstreamBody !== rawBody) {
      delete requestHeaders["content-encoding"];
    }

    let finalResult: BufferedUpstreamResult | null = null;

    if (!finalResult) {
      const result = await sendBufferedUpstreamRequest({
        req,
        res,
        upstream,
        startedAt,
        timeoutMs: config.timeouts.claude_ms,
        timeoutMessage: "Claude upstream request timed out.",
        requestHeaders,
        body: upstreamBody,
        extraResponseHeaders: {
          "x-compactgate-route": route,
          "x-compactgate-claude-route": "primary",
          "x-compactgate-request-id": requestId
        },
        writeResponse: true
      });

      finalResult = result;
      status = result.status;
      errorSummary = result.errorSummary;
    }

    if (!finalResult) {
      throw new Error("Claude upstream request did not complete.");
    }

    const completedResult = finalResult;

    if (!res.headersSent) {
      copyResponseHeaders(completedResult.responseHeaders, res);
      res.setHeader("x-compactgate-route", route);
      res.setHeader("x-compactgate-claude-route", "primary");
      res.setHeader("x-compactgate-request-id", requestId);
      res.writeHead(completedResult.status);
      res.end(completedResult.responseBody);
    }

    status = completedResult.status;
    errorSummary = completedResult.errorSummary;
    responseBody = completedResult.responseBody;
    responseHeaders = completedResult.responseHeaders;
    requestType = responseTransport(responseHeaders) ?? requestType;
    firstTokenMs = completedResult.firstTokenMs;
    usage = extractResponseUsage(responseBody, responseHeaders);
  } catch (error) {
    status = error instanceof RequestBodyTooLargeError ? 413 : 502;
    errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendJson(res, status, { error: errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(errorSummary));
    }
  } finally {
    const logUrl = new URL(`${upstreamPath}${url.search}`, "http://compactgate.local");
    const logEntry = addLog(logger, {
      route,
      req,
      url: logUrl,
      status,
      startedAt,
      endpoint: requestMetadata?.endpoint ?? endpointFromPath(upstreamPath),
      requestType,
      reasoningEffort: requestMetadata?.reasoningEffort ?? null,
      requestSummary: requestMetadata?.requestSummary ?? null,
      upstreamHost: upstream.host,
      requestId,
      sourceModel,
      targetModel,
      firstTokenMs,
      usage,
      errorSummary
    });
    studioEvents.broadcastLog(logEntry);

    await persistCapture(captureWriter, () => ({
      request_id: requestId,
      time: new Date().toISOString(),
      route,
      method: req.method ?? "GET",
      path: `${upstreamPath}${url.search}`,
      upstream_url: upstream.toString(),
      upstream_host: upstream.host,
      source_model: sourceModel,
      target_model: targetModel,
      compact_bridge_replacements: 0,
      incoming_request: {
        headers: serializeHeaders(req.headers),
        body: captureWriter.serializeBody(rawBody)
      },
      upstream_request: {
        headers: serializeHeaders(requestHeaders),
        body: captureWriter.serializeBody(upstreamBody.byteLength > 0 ? upstreamBody : rawBody)
      },
      upstream_response: {
        status,
        headers: serializeHeaders(responseHeaders),
        body: captureWriter.serializeBody(responseBody)
      }
    }));
  }
}

export function isAnthropicProxyPath(pathname: string): boolean {
  return pathname === ANTHROPIC_PROXY_PREFIX || pathname.startsWith(`${ANTHROPIC_PROXY_PREFIX}/`);
}

function stripAnthropicProxyPrefix(pathname: string): string {
  const stripped = pathname.slice(ANTHROPIC_PROXY_PREFIX.length);
  return stripped.length > 0 ? stripped : "/";
}
