import type { IncomingHttpHeaders } from "node:http";
import type { CompactGateConfig, RouteKind } from "../shared/types.js";
import type {
  CompactionBridgeScope,
  CompactionBridgeStore
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
  extractJsonModel,
  rewriteCompactBody
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
  const sourceModel = extractJsonModel(rawBody).sourceModel;
  const compactBridgeScope = compactBridgeScopeFor(config, sourceModel);

  const primarySelection = primaryFailover.select(
    config,
    primaryRouteRequestContextFromBody(rawBody, headers, endpoint)
  );
  const selectedPrimaryConfig = primarySelection.config;
  const bridgeResult =
    config.compact.upstream_mode === "split"
      ? compactionBridge.rewritePrimaryBody(rawBody, compactBridgeScope)
      : { body: rawBody, replacedCompactionCount: 0 };

  return withRequestHeaders(headers, resolveRouteCredential("primary", selectedPrimaryConfig).apiKey ?? "", rawBody, {
    route: "primary",
    upstream: buildUpstreamUrl(selectedPrimaryConfig.primary.base_url, url.pathname, url.search),
    timeoutMs: config.timeouts.primary_ms,
    timeoutMessage: "Primary upstream request timed out.",
    upstreamBody: bridgeResult.body,
    sourceModel,
    targetModel: sourceModel,
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
