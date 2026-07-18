import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { RouteKind } from "../shared/types.js";
import type { ConfigStore } from "./config.js";
import {
  buildAnthropicUpstreamHeaders,
  buildClaudeUpstreamUrl,
  resolveClaudeCredential,
  resolveClaudeMappedModel,
  rewriteClaudeModelBody
} from "./claude-models.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import {
  copyResponseHeaders,
  RequestBodyTooLargeError,
  readRawBody,
  sendJson,
  summaryForError
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import {
  applyOpenAiProxyUpstreamResult,
  createOpenAiProxyTransactionState,
  finalizeOpenAiProxyTransaction
} from "./openai-proxy-transaction.js";
import { StudioEventBroadcaster } from "./studio-events.js";
import {
  extractRequestMetadata,
  extractResponseUsage,
  extractSourceModel,
  responseTransport
} from "./usage.js";
import {
  classifyOpenAiUpstreamResult,
  sendBufferedUpstreamRequest,
  type BufferedUpstreamResult,
  UpstreamRequestError
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
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  const config = configStore.get();
  const route: RouteKind = "claude";
  const requestId = randomUUID();
  const upstreamPath = stripAnthropicProxyPrefix(url.pathname);
  let upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
  const transaction = createOpenAiProxyTransactionState();

  try {
    transaction.rawBody = await readRawBody(req, 100 * 1024 * 1024);
    transaction.requestMetadata = extractRequestMetadata(upstreamPath, transaction.rawBody);
    transaction.requestType = transaction.requestMetadata.requestType;
    transaction.sourceModel = extractSourceModel(transaction.rawBody);
    transaction.targetModel = resolveClaudeMappedModel(transaction.sourceModel, config, transaction.rawBody) ?? transaction.sourceModel;
    upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
    transaction.upstreamBody = rewriteClaudeModelBody(transaction.rawBody, transaction.targetModel ?? "");
    const auth = resolveClaudeCredential(config);
    transaction.requestHeaders = buildAnthropicUpstreamHeaders(req.headers, auth.apiKey);
    if (transaction.upstreamBody !== transaction.rawBody) {
      delete transaction.requestHeaders["content-encoding"];
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
        requestHeaders: transaction.requestHeaders,
        body: transaction.upstreamBody,
        extraResponseHeaders: {
          "x-compactgate-route": route,
          "x-compactgate-claude-route": "primary",
          "x-compactgate-request-id": requestId
        },
        maxBufferedResponseBytes: Number.POSITIVE_INFINITY,
        writeResponse: true
      });

      finalResult = result;
      applyOpenAiProxyUpstreamResult(transaction, result);
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

    applyOpenAiProxyUpstreamResult(transaction, completedResult);
    transaction.streamOutcome = classifyOpenAiUpstreamResult(completedResult);
    transaction.requestType = responseTransport(transaction.responseHeaders) ?? transaction.requestType;
    transaction.usage = extractResponseUsage(transaction.responseBody, transaction.responseHeaders);
  } catch (error) {
    if (error instanceof UpstreamRequestError) {
      transaction.upstreamStatus = error.details.status;
      transaction.responseBody = error.details.responseBody;
      transaction.responseHeaders = error.details.responseHeaders;
      transaction.firstTokenMs = error.details.firstTokenMs;
      transaction.streamTerminalEvent = error.details.streamSummary?.terminalEvent ?? null;
      transaction.clientDisconnectPhase = error.details.clientDisconnectPhase;
      transaction.streamOversizedEventCount = error.details.streamSummary?.oversizedEventCount ?? 0;
      transaction.streamOutcome = error.details.kind === "client_cancel"
        ? error.details.clientDisconnectPhase === "after_terminal"
          ? "client_cancel_after_terminal"
          : "client_cancel"
        : error.details.kind;
    }
    transaction.status = error instanceof RequestBodyTooLargeError ? 413 : 502;
    transaction.errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendJson(res, transaction.status, { error: transaction.errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(transaction.errorSummary));
    }
  } finally {
    const logUrl = new URL(`${upstreamPath}${url.search}`, "http://compactgate.local");
    await finalizeOpenAiProxyTransaction({
      logger,
      captureWriter,
      studioEvents,
      route,
      compactionMode: null,
      compactionDetectionSource: null,
      req,
      url: logUrl,
      status: transaction.status,
      upstreamStatus: transaction.upstreamStatus,
      streamTerminalEvent: transaction.streamTerminalEvent,
      clientDisconnectPhase: transaction.clientDisconnectPhase,
      streamOutcome: transaction.streamOutcome,
      streamOversizedEventCount: transaction.streamOversizedEventCount,
      startedAt,
      startedAtIso,
      requestMetadata: transaction.requestMetadata,
      requestType: transaction.requestType,
      upstream,
      requestId,
      sourceModel: transaction.sourceModel,
      targetModel: transaction.targetModel,
      firstTokenMs: transaction.firstTokenMs,
      usage: transaction.usage,
      errorSummary: transaction.errorSummary,
      compactBridgeReplacements: transaction.compactBridgeReplacements,
      rawBody: transaction.rawBody,
      requestHeaders: transaction.requestHeaders,
      upstreamBody: transaction.upstreamBody.byteLength > 0
        ? transaction.upstreamBody
        : transaction.rawBody,
      responseBody: transaction.responseBody,
      responseHeaders: transaction.responseHeaders,
      clientResponseBody: transaction.clientResponseBody,
      clientResponseHeaders: transaction.clientResponseHeaders,
      persistBody: config.logging.persist_body,
      compactResponseNormalized: transaction.compactResponseNormalized,
      compactResponseNormalizeReason: transaction.compactResponseNormalizeReason,
      compactResponseSyntheticSource: transaction.compactResponseSyntheticSource
    });
  }
}

export function isAnthropicProxyPath(pathname: string): boolean {
  return pathname === ANTHROPIC_PROXY_PREFIX || pathname.startsWith(`${ANTHROPIC_PROXY_PREFIX}/`);
}

function stripAnthropicProxyPrefix(pathname: string): string {
  const stripped = pathname.slice(ANTHROPIC_PROXY_PREFIX.length);
  return stripped.length > 0 ? stripped : "/";
}
