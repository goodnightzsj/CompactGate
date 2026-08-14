import type { IncomingHttpHeaders } from "node:http";
import type { CompactGateConfig, RouteKind, UpstreamProtocol } from "../shared/types.js";
import {
  CompactionBridgeScope,
  CompactionBridgeStore,
  UnresolvedCompactionStateError
} from "./compaction-bridge.js";
import { resolveRouteCredential } from "./credentials.js";
import { buildUpstreamHeaders, parseJsonRecord } from "./http-utils.js";
import {
  buildAnthropicUpstreamHeaders,
  buildClaudeUpstreamUrl
} from "./claude-models.js";
import {
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody,
  type PrimaryRouteSelection
} from "./primary-failover.js";
import {
  buildUpstreamUrl,
  compactUpstreamBaseUrl,
  deriveCompactModel,
  rewriteCompactBody,
  rewritePrimaryBody
} from "./routing.js";
import {
  responsesRequestToChat,
  responsesCompactRequestToAnthropic,
  responsesRequestToAnthropic,
  ProtocolConversionError
} from "./protocol-conversion.js";

const ANTHROPIC_COMPACTION_BETA = "compact-2026-01-12";

export interface OpenAiProxyPlan {
  route: RouteKind;
  upstream: URL;
  timeoutMs: number;
  timeoutMessage: string;
  requestHeaders: Record<string, string>;
  upstreamBody: Buffer;
  sourceModel: string | null;
  targetModel: string | null;
  compactBridgeReplacements: number;
  compactBridgeScope: CompactionBridgeScope | null;
  primarySelection: PrimaryRouteSelection | null;
  upstreamProtocol: UpstreamProtocol;
}

export function buildPrimaryOpenAiProxyPlan({
  config,
  url,
  headers,
  rawBody,
  endpoint,
  compactionBridge,
  primaryFailover,
  preserveRemoteV2State = false
}: {
  config: CompactGateConfig;
  url: URL;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  endpoint: string;
  compactionBridge: CompactionBridgeStore;
  primaryFailover: PrimaryFailoverState;
  preserveRemoteV2State?: boolean;
}): OpenAiProxyPlan {
  const primarySelection = primaryFailover.preview(
    config,
    primaryRouteRequestContextFromBody(rawBody, headers, endpoint)
  );
  const selectedPrimaryConfig = primarySelection.config;
  const modelRewrite = rewritePrimaryBody(rawBody, selectedPrimaryConfig, endpoint);
  const sourceModel = modelRewrite.sourceModel;
  const compactBridgeScope: CompactionBridgeScope = {
    compactUpstream: compactUpstreamBaseUrl(config),
    sourceModel,
    targetModel: sourceModel ? deriveCompactModel(sourceModel, config) : null
  };
  const upstreamProtocol = selectedPrimaryConfig.primary.upstream_protocol;
  const splitCompactMode = config.compact.upstream_mode === "split";
  const preserveProviderState = preserveRemoteV2State && upstreamProtocol === "openai_responses";
  const bridgeResult = preserveProviderState
    ? {
        body: modelRewrite.body,
        replacedCompactionCount: 0,
        remainingCompactionCount: 0,
        knownMissingCompactionCount: 0
      }
    : compactionBridge.rewritePrimaryBody(modelRewrite.body, compactBridgeScope, {
        includeStandardFallbacks: splitCompactMode,
        includeSyntheticFallbacks: true,
        allowReadableFallback: splitCompactMode
      });
  if (
    !preserveProviderState &&
    (
      upstreamProtocol === "openai_responses"
        ? splitCompactMode && bridgeResult.knownMissingCompactionCount > 0
        : bridgeResult.remainingCompactionCount > 0
    )
  ) {
    throw new UnresolvedCompactionStateError(bridgeResult.remainingCompactionCount);
  }

  const upstreamBody = translateOpenAiRequest(bridgeResult.body, upstreamProtocol);
  const upstreamPath = upstreamProtocol === "anthropic_messages"
    ? "/v1/messages"
    : upstreamProtocol === "openai_chat"
      ? "/v1/chat/completions"
      : url.pathname;

  const plan = withRequestHeaders(
    headers,
    resolveRouteCredential("primary", selectedPrimaryConfig).apiKey ?? "",
    rawBody,
    {
      route: "primary",
      upstream: upstreamProtocol === "anthropic_messages"
        ? buildClaudeUpstreamUrl(selectedPrimaryConfig.primary.base_url, upstreamPath, url.search)
        : buildUpstreamUrl(selectedPrimaryConfig.primary.base_url, upstreamPath, url.search),
      timeoutMs: config.timeouts.primary_ms,
      timeoutMessage: "Primary upstream request timed out.",
      upstreamBody,
      sourceModel,
      targetModel: modelRewrite.targetModel,
      compactBridgeReplacements: bridgeResult.replacedCompactionCount,
      compactBridgeScope,
      primarySelection,
      upstreamProtocol
    }
  );
  primaryFailover.reserveSelection(primarySelection, config.primary_failover.auto_schedule);
  return plan;
}

export function buildCompactOpenAiProxyPlan({
  config,
  url,
  headers,
  rawBody,
  nativeCompaction
}: {
  config: CompactGateConfig;
  url: URL;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  nativeCompaction: boolean;
}): OpenAiProxyPlan {
  const rewrite = rewriteCompactBody(rawBody, config);
  const upstreamProtocol = config.compact.upstream_mode === "split"
    ? config.compact.upstream_protocol
    : config.primary.upstream_protocol;
  const upstreamBody = translateCompactOpenAiRequest(rewrite.body, upstreamProtocol, nativeCompaction);
  const upstreamPath = upstreamProtocol === "anthropic_messages" ? "/v1/messages" : url.pathname;
  const credential = resolveRouteCredential("compact", config);
  const plan = withRequestHeaders(headers, credential.apiKey, rawBody, {
    route: "compact",
    upstream: upstreamProtocol === "anthropic_messages"
      ? buildClaudeUpstreamUrl(compactUpstreamBaseUrl(config), upstreamPath, url.search)
      : buildUpstreamUrl(compactUpstreamBaseUrl(config), upstreamPath, url.search),
    timeoutMs: config.timeouts.compact_ms,
    timeoutMessage: "Compact upstream request timed out.",
    upstreamBody,
    sourceModel: rewrite.sourceModel,
    targetModel: rewrite.targetModel,
    compactBridgeReplacements: 0,
    compactBridgeScope: {
      compactUpstream: compactUpstreamBaseUrl(config),
      sourceModel: rewrite.sourceModel,
      targetModel: rewrite.targetModel
    },
    primarySelection: null,
    upstreamProtocol
  });
  if (config.compact.upstream_mode === "split" && !credential.apiKeyConfigured) {
    delete plan.requestHeaders.authorization;
  }
  return plan;
}

function withRequestHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null,
  rawBody: Buffer,
  plan: Omit<OpenAiProxyPlan, "requestHeaders">
): OpenAiProxyPlan {
  const requestHeaders = plan.upstreamProtocol === "anthropic_messages"
    ? buildAnthropicRequestHeaders(
        headers,
        apiKey,
        parseJsonRecord(plan.upstreamBody)?.context_management !== undefined
      )
    : plan.upstreamProtocol === "openai_chat"
      ? buildOpenAiChatRequestHeaders(headers, apiKey)
      : buildUpstreamHeaders(headers, apiKey);
  if (plan.upstreamBody !== rawBody) {
    delete requestHeaders["content-encoding"];
  }

  return {
    ...plan,
    requestHeaders
  };
}

function translateOpenAiRequest(body: Buffer, protocol: UpstreamProtocol): Buffer {
  if (protocol === "openai_responses") {
    return body;
  }
  if (protocol === "anthropic_messages") {
    return responsesRequestToAnthropic(body).body;
  }
  return responsesRequestToChat(body).body;
}

function translateCompactOpenAiRequest(
  body: Buffer,
  protocol: UpstreamProtocol,
  nativeCompaction: boolean
): Buffer {
  if (protocol === "openai_responses") {
    return body;
  }
  if (protocol === "anthropic_messages") {
    return nativeCompaction
      ? responsesCompactRequestToAnthropic(body).body
      : responsesRequestToAnthropic(body).body;
  }
  throw new ProtocolConversionError("OpenAI Chat upstream cannot handle Responses compaction requests.");
}

function buildAnthropicRequestHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null,
  compaction: boolean
): Record<string, string> {
  const next = buildAnthropicUpstreamHeaders(headers, apiKey);
  next["anthropic-version"] ||= "2023-06-01";
  next["accept-encoding"] = "identity";
  if (compaction) {
    next["anthropic-beta"] = appendHeaderToken(next["anthropic-beta"], ANTHROPIC_COMPACTION_BETA);
  }
  for (const name of Object.keys(next)) {
    if (name.startsWith("x-codex-") || name.startsWith("openai-")) {
      delete next[name];
    }
  }
  return next;
}

function buildOpenAiChatRequestHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null
): Record<string, string> {
  const next = buildUpstreamHeaders(headers, apiKey);
  next["accept-encoding"] = "identity";
  for (const name of Object.keys(next)) {
    if (name.startsWith("x-codex-")) {
      delete next[name];
    }
  }
  return next;
}

function appendHeaderToken(value: string | undefined, token: string): string {
  const tokens = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!tokens.includes(token)) {
    tokens.push(token);
  }
  return tokens.join(",");
}
