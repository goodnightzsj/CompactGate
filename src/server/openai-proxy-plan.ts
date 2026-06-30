import type { IncomingHttpHeaders } from "node:http";
import type { CompactGateConfig, RouteKind } from "../shared/types.js";
import {
  CompactionBridgeScope,
  CompactionBridgeStore,
  UnresolvedCompactionStateError
} from "./compaction-bridge.js";
import { resolveRouteCredential } from "./credentials.js";
import { buildUpstreamHeaders } from "./http-utils.js";
import {
  PrimaryFailoverState,
  primaryRouteRequestContextFromBody,
  type PrimaryRouteSelection
} from "./primary-failover.js";
import {
  buildUpstreamUrl,
  compactUpstreamBaseUrl,
  compactUpstreamPath,
  deriveCompactModel,
  rewriteCompactBody,
  rewritePrimaryBody
} from "./routing.js";

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
}

export function buildPrimaryOpenAiProxyPlan({
  config,
  url,
  headers,
  rawBody,
  endpoint,
  compactionBridge,
  primaryFailover
}: {
  config: CompactGateConfig;
  url: URL;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  endpoint: string;
  compactionBridge: CompactionBridgeStore;
  primaryFailover: PrimaryFailoverState;
}): OpenAiProxyPlan {
  const modelRewrite = rewritePrimaryBody(rawBody, config);
  const sourceModel = modelRewrite.sourceModel;
  const compactBridgeScope = compactBridgeScopeFor(config, sourceModel);
  const splitCompactMode = config.compact.upstream_mode === "split";
  const bridgeResult = compactionBridge.rewritePrimaryBody(modelRewrite.body, compactBridgeScope, {
    includeStandardFallbacks: splitCompactMode,
    includeSyntheticFallbacks: true,
    allowReadableFallback: splitCompactMode
  });
  if (splitCompactMode && bridgeResult.knownMissingCompactionCount > 0) {
    throw new UnresolvedCompactionStateError(bridgeResult.remainingCompactionCount);
  }

  const primarySelection = primaryFailover.select(
    config,
    primaryRouteRequestContextFromBody(rawBody, headers, endpoint)
  );
  const selectedPrimaryConfig = primarySelection.config;

  return withRequestHeaders(headers, resolveRouteCredential("primary", selectedPrimaryConfig).apiKey ?? "", rawBody, {
    route: "primary",
    upstream: buildUpstreamUrl(selectedPrimaryConfig.primary.base_url, url.pathname, url.search),
    timeoutMs: config.timeouts.primary_ms,
    timeoutMessage: "Primary upstream request timed out.",
    upstreamBody: bridgeResult.body,
    sourceModel,
    targetModel: modelRewrite.targetModel,
    compactBridgeReplacements: bridgeResult.replacedCompactionCount,
    compactBridgeScope,
    primarySelection
  });
}

export function buildCompactOpenAiProxyPlan({
  config,
  url,
  headers,
  rawBody
}: {
  config: CompactGateConfig;
  url: URL;
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
}): OpenAiProxyPlan {
  const rewrite = rewriteCompactBody(rawBody, config);
  const upstreamPath = compactUpstreamPath(config, url.pathname);
  return withRequestHeaders(headers, resolveRouteCredential("compact", config).apiKey, rawBody, {
    route: "compact",
    upstream: buildUpstreamUrl(compactUpstreamBaseUrl(config), upstreamPath, url.search),
    timeoutMs: config.timeouts.compact_ms,
    timeoutMessage: "Compact upstream request timed out.",
    upstreamBody: rewrite.body,
    sourceModel: rewrite.sourceModel,
    targetModel: rewrite.targetModel,
    compactBridgeReplacements: 0,
    compactBridgeScope: {
      compactUpstream: compactUpstreamBaseUrl(config),
      sourceModel: rewrite.sourceModel,
      targetModel: rewrite.targetModel
    },
    primarySelection: null
  });
}

function compactBridgeScopeFor(
  config: CompactGateConfig,
  sourceModel: string | null
): CompactionBridgeScope {
  return {
    compactUpstream: compactUpstreamBaseUrl(config),
    sourceModel,
    targetModel: sourceModel ? deriveCompactModel(sourceModel, config) : null
  };
}

function withRequestHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | null,
  rawBody: Buffer,
  plan: Omit<OpenAiProxyPlan, "requestHeaders">
): OpenAiProxyPlan {
  const requestHeaders = buildUpstreamHeaders(headers, apiKey);
  if (plan.upstreamBody !== rawBody) {
    delete requestHeaders["content-encoding"];
  }

  return {
    ...plan,
    requestHeaders
  };
}
