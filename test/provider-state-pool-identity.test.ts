import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/server/config.js";
import * as routingCandidates from "../src/server/primary-failover-candidates.js";
import { RequestLogger } from "../src/server/logger.js";
import { hashStateDomain } from "../src/server/provider-state-domain.js";
import { captureRequest, startApp, startUpstream, JSON_HEADERS, writeJsonResponse, waitForLogEntry } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());
const profileId = "profile#special";
function profiles(url: string) {
  return { codex: { active_profile_id: profileId, profiles: [{
    id: profileId, name: "Synthetic", config: {
      primary: { ...DEFAULT_CONFIG.primary, base_url: url, api_key: "", api_keys: [
        { id: "key#first", label: "First", api_key: "synthetic-first", enabled: true },
        { id: "key#second", label: "Second", api_key: "synthetic-second", enabled: true }
      ] }, compact: { ...DEFAULT_CONFIG.compact }
    }
  }] } };
}
const body = { model: "synthetic", store: false, input: [{ role: "user", content: "Synthetic turn" }] };

it("resolves an in-memory pooled continuation to its raw profile and actual key domain", async () => {
  const upstream = await startUpstream(async (req, res) => {
    await captureRequest(req);
    if (req.headers.authorization === "Bearer synthetic-first") writeJsonResponse(res, { error: "invalid token" }, 401);
    else writeJsonResponse(res, { status: "completed", output: [] });
  });
  const app = await startApp(upstream.url, upstream.url, { profile_scopes: profiles(upstream.url) });
  const post = (input: unknown) => fetch(`${app.url}/v1/responses`, { method: "POST",
    headers: { ...JSON_HEADERS, "x-compactgate-session": "synthetic-pool-session" }, body: JSON.stringify(input) });
  await (await post(body)).text();
  await waitForLogEntry(app.url, log => log.status === 401);
  await (await post(body)).text();
  await waitForLogEntry(app.url, log => log.status === 200);
  const enumerate = vi.spyOn(routingCandidates, "codexPrimaryCandidates");
  const binding = vi.spyOn(RequestLogger.prototype, "findProviderStateBinding").mockReturnValue(null);
  const reply = await post({ ...body, input: [{ type: "reasoning", encrypted_content: "synthetic-opaque" }, ...body.input] });
  expect(reply.status).toBe(200); await reply.text();
  const log = await waitForLogEntry(app.url, entry => entry.provider_state_portability?.stateful_item_counts.encrypted_reasoning === 1);
  expect(enumerate).toHaveBeenCalledTimes(1);
  expect(log.provider_state_portability?.source_profile_id).toBe(profileId);
  expect(log.provider_state_portability?.source_state_domain_hash).toBe(hashStateDomain(
    `profile:profile%0023special#key%0023second:${new URL(upstream.url).origin}`
  ));
  enumerate.mockClear();
  binding.mockReturnValue({ profileId: "saved", stateDomainId: "saved-domain", generation: 1, expiresAt: Date.now() + 60_000 });
  const saved = await post(body);
  expect(saved.status).toBe(200); await saved.text();
  const savedLog = await waitForLogEntry(app.url, entry => entry.provider_state_portability?.source_profile_id === "saved");
  expect(savedLog.provider_state_portability?.source_state_domain_hash).toBe(hashStateDomain("saved-domain"));
  expect(enumerate).toHaveBeenCalledTimes(1);
});

it("binds an explicitly selected pooled profile to the credential actually sent", async () => {
  const upstream = await startUpstream(async (req, res) => {
    await captureRequest(req);
    expect(req.headers.authorization).toBe("Bearer synthetic-first");
    writeJsonResponse(res, { status: "completed", output: [] });
  });
  const app = await startApp(upstream.url, upstream.url, { profile_scopes: profiles(upstream.url) });
  const enumerate = vi.spyOn(routingCandidates, "codexPrimaryCandidates");
  const reply = await fetch(`${app.url}/v1/responses`, { method: "POST",
    headers: { ...JSON_HEADERS, "x-compactgate-profile": profileId }, body: JSON.stringify(body) });
  expect(reply.status).toBe(200); await reply.text();
  const log = await waitForLogEntry(app.url, entry => entry.status === 200);
  expect(log.provider_state_portability?.target_state_domain_hash).toBe(hashStateDomain(
    `profile:profile%0023special#key%0023first:${new URL(upstream.url).origin}`
  ));
  expect(enumerate).not.toHaveBeenCalled();
  expect(app.config.get().profile_scopes?.codex?.active_profile_id).toBe(profileId);
});
