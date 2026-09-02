import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { RouteKind } from "../shared/types.js";
import type { ConfigStore } from "./config.js";
import { MAX_CLAUDE_LONG_CONTEXT_BYTES } from "./config-internals.js";
import {
  buildAnthropicUpstreamHeaders,
  buildClaudeUpstreamUrl,
  resolveClaudeCredential,
  resolveClaudeMappedModel,
  resolveClaudeRequestRouting,
  rewriteClaudeModelBody
} from "./claude-models.js";
import type { DebugCaptureWriter } from "./debug-capture.js";
import type { ClaudeKeyPoolState } from "./claude-key-pool.js";
import { applyHostQuirks, resolveHostShortCircuit } from "./host-quirks.js";
import {
  buildUpstreamHeaders,
  copyResponseHeaders,
  RequestBodyTooLargeError,
  readRawBody,
  sendJson,
  summaryForError
} from "./http-utils.js";
import type { RequestLogger } from "./logger.js";
import {
  applyOpenAiProxyUpstreamResult,
  applyUpstreamFailureToTransaction,
  createOpenAiProxyTransactionState,
  finalizeFromTransaction
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
  classifyAnthropicUpstreamResult,
  sendBufferedUpstreamRequest,
  summarizeOpenAiStreamFailure,
  summarizeAnthropicStreamFailure,
  UpstreamRequestError
} from "./upstream-client.js";
import {
  anthropicRequestToChat,
  anthropicRequestToResponses,
  ProtocolConversionError
} from "./protocol-conversion.js";
import {
  createAnthropicPassthroughResponseTransform,
  createChatToAnthropicResponseTransform,
  createOpenAiInputTokensToAnthropicResponseTransform,
  createResponsesToAnthropicResponseTransform
} from "./protocol-stream.js";
import { buildUpstreamUrl } from "./routing.js";

export const ANTHROPIC_PROXY_PREFIX = "/anthropic";

export async function proxyClaudeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  configStore: ConfigStore,
  logger: RequestLogger,
  captureWriter: DebugCaptureWriter,
  studioEvents: StudioEventBroadcaster,
  claudeKeyPool?: ClaudeKeyPoolState
): Promise<void> {
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  const baseConfig = configStore.get();
  let config = baseConfig;
  const route: RouteKind = "claude";
  const requestId = randomUUID();
  const strippedUpstreamPath = url.pathname.slice(ANTHROPIC_PROXY_PREFIX.length);
  const upstreamPath = strippedUpstreamPath || "/";
  let upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
  let routing: ReturnType<typeof resolveClaudeRequestRouting> | null = null;
  const transaction = createOpenAiProxyTransactionState();
  let claudeKeySelection: { keyId: string; apiKey: string } | null = null;

  try {
    // Above `readRawBody`'s 10 MiB default because long-context routing keys off the
    // body size: a body large enough to route must still be readable.
    transaction.rawBody = await readRawBody(req, MAX_CLAUDE_LONG_CONTEXT_BYTES);
    transaction.requestMetadata = extractRequestMetadata(upstreamPath, transaction.rawBody);
    transaction.requestType = transaction.requestMetadata.requestType;
    transaction.sourceModel = extractSourceModel(transaction.rawBody);
    routing = resolveClaudeRequestRouting(
      baseConfig,
      transaction.rawBody,
      transaction.sourceModel,
      req.headers,
      req.socket.remoteAddress
    );
    config = routing.config;
    if (claudeKeyPool && routing.profileId) {
      claudeKeySelection = claudeKeyPool.select(config, routing.profileId, req.headers);
    }
    if (claudeKeySelection) {
      config = {
        ...config,
        claude: {
          ...config.claude,
          primary: {
            ...config.claude.primary,
            api_key: claudeKeySelection.apiKey,
            // Emptied alongside, or the selection is inert: `resolveRouteCredential`
            // reads the pool before falling back, so a request that rotated onto the
            // second key still went out on the first — and the pool's health then
            // recorded that verdict against the key it never sent. This copy is
            // per-request and in memory only; an empty pool in the *file* means
            // "cleared", which is why the array is never emptied there.
            api_keys: []
          }
        }
      };
    }
    transaction.targetModel = routing.sceneModel ??
      resolveClaudeMappedModel(transaction.sourceModel, config, transaction.rawBody) ??
      transaction.sourceModel;
    const upstreamProtocol = config.claude.primary.upstream_protocol;
    const countTokens = upstreamPath === "/v1/messages/count_tokens" || upstreamPath === "/messages/count_tokens";
    const openAiUpstream = upstreamProtocol === "openai_responses" || upstreamProtocol === "openai_chat";
    transaction.upstreamBody = rewriteClaudeModelBody(
      transaction.rawBody,
      transaction.targetModel ?? "",
      !openAiUpstream && !countTokens
    );
    if (transaction.upstreamBody === transaction.rawBody) {
      // The body was unreadable, so no mapping was applied; report what the
      // upstream actually receives rather than the model we meant to send.
      transaction.targetModel = transaction.sourceModel;
    }
    if (openAiUpstream) {
      const conversion = upstreamProtocol === "openai_chat"
        ? anthropicRequestToChat(transaction.upstreamBody, { countTokens })
        : anthropicRequestToResponses(transaction.upstreamBody, { countTokens });
      transaction.upstreamBody = conversion;
      upstream = buildUpstreamUrl(
        config.claude.primary.base_url,
        upstreamProtocol === "openai_chat"
          ? "/v1/chat/completions"
          : countTokens
            ? "/v1/responses/input_tokens"
            : "/v1/responses",
        url.search
      );
      const auth = resolveClaudeCredential(config);
      transaction.requestHeaders = buildOpenAiRequestHeaders(
        req.headers,
        auth.apiKey,
        config.claude.primary.extra_headers
      );
    } else {
      upstream = buildClaudeUpstreamUrl(config.claude.primary.base_url, upstreamPath, url.search);
      const auth = resolveClaudeCredential(config);
      transaction.requestHeaders = buildAnthropicUpstreamHeaders(
        req.headers,
        auth.apiKey,
        config.claude.primary.extra_headers
      );
    }
    applyHostQuirks({
      host: upstream.hostname,
      sourceModel: transaction.sourceModel,
      targetModel: transaction.targetModel,
      headers: transaction.requestHeaders
    });
    transaction.sensitiveHeaderNames = Object.keys(config.claude.primary.extra_headers);
    if (transaction.upstreamBody !== transaction.rawBody) {
      delete transaction.requestHeaders["content-encoding"];
    }

    const routeHeaders = {
      "x-compactgate-route": route,
      "x-compactgate-claude-route": "primary",
      "x-compactgate-claude-scene": routing.scene,
      ...(routing.profileId
        ? {
            "x-compactgate-profile": routing.profileId,
            "x-compactgate-profile-source": routing.profileSource
          }
        : {}),
      "x-compactgate-request-id": requestId
    };

    const shortCircuit = resolveHostShortCircuit({
      host: upstream.hostname,
      upstreamPath,
      rawBody: transaction.rawBody
    });
    if (shortCircuit) {
      transaction.status = 200;
      transaction.responseBody = shortCircuit.body;
      transaction.responseHeaders = { "content-type": "application/json" };
      transaction.streamOutcome = "success";
      copyResponseHeaders(transaction.responseHeaders, res);
      for (const [name, value] of Object.entries(routeHeaders)) {
        res.setHeader(name, value);
      }
      res.setHeader("x-compactgate-short-circuit", shortCircuit.id);
      res.writeHead(200);
      res.end(shortCircuit.body);
      return;
    }

    const completedResult = await sendBufferedUpstreamRequest({
      req,
      res,
      upstream,
      startedAt,
      timeoutMs: config.timeouts.claude_ms,
      timeoutMessage: "Claude upstream request timed out.",
      requestHeaders: transaction.requestHeaders,
      proxyUrl: config.claude.primary.proxy_url,
      body: transaction.upstreamBody,
      extraResponseHeaders: routeHeaders,
      maxBufferedResponseBytes: Number.POSITIVE_INFINITY,
      streamProtocol: upstreamProtocol === "anthropic_messages" ? "anthropic" : "openai",
      writeResponse: true,
      responseTransform: upstreamProtocol === "openai_responses"
        ? countTokens
          ? createOpenAiInputTokensToAnthropicResponseTransform
          : createResponsesToAnthropicResponseTransform
        : upstreamProtocol === "openai_chat"
          ? createChatToAnthropicResponseTransform
          : createAnthropicPassthroughResponseTransform
    });
    // An Anthropic upstream is forwarded verbatim apart from a repaired
    // terminator, so every diagnostic has to be read off the upstream stream and
    // never off the repaired one — otherwise the repair would report a truncated
    // upstream as a clean message_stop and hide the failure it compensates for.
    const passthroughUpstream = upstreamProtocol === "anthropic_messages";
    const observedResult = passthroughUpstream
      ? { ...completedResult, clientStreamSummary: null }
      : completedResult;
    applyOpenAiProxyUpstreamResult(transaction, observedResult);

    if (!res.headersSent) {
      copyResponseHeaders(completedResult.clientResponseHeaders ?? completedResult.responseHeaders, res);
      for (const [name, value] of Object.entries(routeHeaders)) {
        res.setHeader(name, value);
      }
      res.writeHead(completedResult.status);
      res.end(completedResult.clientResponseBody ?? completedResult.responseBody);
    }

    const responseWasTransformed = !passthroughUpstream &&
      completedResult.clientResponseHeaders !== null &&
      completedResult.clientResponseHeaders !== undefined;
    const clientResult = responseWasTransformed
      ? { ...completedResult, streamSummary: completedResult.clientStreamSummary ?? null }
      : completedResult;
    transaction.streamOutcome = responseWasTransformed
      ? classifyAnthropicUpstreamResult(clientResult)
      : upstreamProtocol === "openai_responses" || upstreamProtocol === "openai_chat"
        ? classifyOpenAiUpstreamResult(completedResult)
        : classifyAnthropicUpstreamResult(completedResult);
    const clientResponseBody = completedResult.clientResponseBody ?? transaction.responseBody;
    const clientResponseHeaders = completedResult.clientResponseHeaders ?? transaction.responseHeaders;
    transaction.requestType = responseTransport(clientResponseHeaders) ?? transaction.requestType;
    transaction.usage = observedResult.clientStreamSummary?.usage ??
      extractResponseUsage(clientResponseBody, clientResponseHeaders);
    if (transaction.requestMetadata.requestType === "stream") {
      transaction.errorSummary ??= responseWasTransformed
        ? summarizeAnthropicStreamFailure(clientResult)
        : upstreamProtocol === "openai_responses" || upstreamProtocol === "openai_chat"
          ? summarizeOpenAiStreamFailure(completedResult)
          : summarizeAnthropicStreamFailure(completedResult);
    }
  } catch (error) {
    if (error instanceof UpstreamRequestError) {
      applyUpstreamFailureToTransaction(transaction, error.details);
    }
    transaction.status = error instanceof ProtocolConversionError
      ? error.status
      : error instanceof RequestBodyTooLargeError
        ? 413
        : 502;
    transaction.errorSummary = summaryForError(error);
    if (!res.headersSent) {
      sendJson(res, transaction.status, { error: transaction.errorSummary, request_id: requestId });
    } else {
      res.destroy(error instanceof Error ? error : new Error(transaction.errorSummary));
    }
  } finally {
    if (claudeKeyPool && routing?.profileId) {
      claudeKeyPool.recordResult(
        routing.profileId,
        claudeKeySelection?.keyId ?? null,
        {
          status: transaction.status,
          responseHeaders: transaction.responseHeaders ?? {},
          firstTokenMs: transaction.firstTokenMs ?? null
        },
        req.headers,
        config
      );
    }
    const logUrl = new URL(`${upstreamPath}${url.search}`, "http://compactgate.local");
    await finalizeFromTransaction(transaction, {
      logger,
      captureWriter,
      studioEvents,
      route,
      compactionMode: null,
      compactionDetectionSource: null,
      req,
      url: logUrl,
      startedAt,
      startedAtIso,
      upstream,
      requestId,
      responseModel: transaction.responseModel,
      upstreamBody: transaction.upstreamBody.byteLength > 0
        ? transaction.upstreamBody
        : transaction.rawBody,
      persistBody: config.logging.persist_body
    });
  }
}

export function isAnthropicProxyPath(pathname: string): boolean {
  return pathname === ANTHROPIC_PROXY_PREFIX || pathname.startsWith(`${ANTHROPIC_PROXY_PREFIX}/`);
}

function buildOpenAiRequestHeaders(
  headers: IncomingMessage["headers"],
  apiKey: string | null,
  extraHeaders: Record<string, string>
): Record<string, string> {
  const next = buildUpstreamHeaders(headers, apiKey, extraHeaders);
  next["accept-encoding"] = "identity";
  for (const name of Object.keys(next)) {
    if (
      name.startsWith("anthropic-") ||
      name === "x-api-key" ||
      name === "x-anthropic-api-key"
    ) {
      delete next[name];
    }
  }
  return next;
}
