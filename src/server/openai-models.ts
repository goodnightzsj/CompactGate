import type { CompactGateConfig } from "../shared/types.js";
import type { ClientIdentityStore } from "./client-identity-store.js";
import { factoryClientUserAgent } from "./config-defaults.js";
import { resolveRouteCredential } from "./credentials.js";
import { buildUpstreamHeaders } from "./http-utils.js";
import {
  fetchUpstreamModels,
  type UpstreamModelsResponse
} from "./upstream-models.js";

export type OpenAiModelsResponse = UpstreamModelsResponse;

/**
 * Relays that whitelist client identity answer the model probe with 401 when it
 * arrives without one, and a bare Node request sends no `user-agent` at all.
 * Proxied traffic passes those gates because the CLI's own headers are forwarded
 * verbatim, so the probe has to introduce itself the same way to see the same
 * catalogue. A generic agent is still rejected, so the product token — not
 * merely the header's presence — is what the gate reads.
 *
 * The `user-agent` is filled from the identity store when one is supplied, which
 * keeps the probe on the same value real traffic carries. The literal below is
 * only the last resort for callers without a store.
 */
const CODEX_CLIENT_IDENTITY: Record<string, string> = {
  accept: "application/json",
  originator: "codex_cli_rs",
  "user-agent": factoryClientUserAgent("codex")
};

export async function fetchOpenAiModels(
  config: CompactGateConfig,
  clientIdentity?: ClientIdentityStore
): Promise<OpenAiModelsResponse> {
  const credential = resolveRouteCredential("primary", config);
  return fetchUpstreamModels({
    baseUrl: config.primary.base_url,
    // Identity rides in as the request baseline, which `extra_headers` overwrites,
    // so an operator can still correct any of it per route.
    headers: buildUpstreamHeaders(
      {
        ...CODEX_CLIENT_IDENTITY,
        "user-agent": clientIdentity?.userAgentFor("codex") ?? CODEX_CLIENT_IDENTITY["user-agent"]
      },
      credential.apiKey,
      config.primary.extra_headers
    ),
    proxyUrl: config.primary.proxy_url,
    timeoutMs: config.timeouts.primary_ms
  });
}
