import { expect, it, vi } from "vitest";
import { ConfigError } from "../src/server/config.js";
import * as oauthTransport from "../src/server/oauth-transport.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { postJson, startApp, startUpstream, waitForLogEntry } from "./helpers/server-test-utils.js";

async function createPool(upstreamUrl: string) {
  const app = await startApp(`${upstreamUrl}/v1`, undefined, {
    primary: { api_key: "synthetic", api_key_env: "" },
    compact: { upstream_mode: "primary" }, logging: { capture_dir: null }
  });
  for (const name of ["A", "B", "C"]) await app.config.saveProfile("codex", name, {});
  const first = app.config.get().profile_scopes?.codex?.profiles?.find((profile) => profile.name === "A");
  if (!first) throw new Error("Missing synthetic profile");
  await app.config.applyProfile("codex", first.id);
  return app;
}

const body = { model: "synthetic", input: "synthetic" };

it.each(["/v1/responses", "/v1/responses/compact"])("releases %s local persistence failures without failing over healthy profiles", async (path) => {
  let requests = 0;
  const upstream = await startUpstream(async (req, res) => {
    for await (const _chunk of req) { /* Consume synthetic input. */ }
    requests++;
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":"synthetic expired credential"}');
  });
  const app = await createPool(upstream.url);
  const initial = await postJson(app.url, path, body);
  expect(initial.status).toBe(401);
  await initial.text();
  const persist = vi.spyOn(app.config, "applyProfile").mockRejectedValue(new Error("Synthetic configuration disk failure"));
  const results = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");
  try {
    for (let index = 0; index < 12; index++) {
      const response = await postJson(app.url, path, body);
      expect(response.status).toBe(path.endsWith("/compact") ? 400 : 502);
      expect(await response.json()).toMatchObject({ error: "Synthetic configuration disk failure" });
    }
    expect(requests).toBe(1);
    expect(results).toHaveBeenCalledTimes(12);
    for (const [selection, result] of results.mock.calls) {
      expect(selection.profileName).toBe("B");
      expect(result).toBeNull();
    }
  } finally { persist.mockRestore(); results.mockRestore(); }
});

it.each([
  ["/v1/responses", 401], ["/v1/responses", 499],
  ["/v1/responses/compact", 401], ["/v1/responses/compact", 499]
])("releases %s OAuth preparation failure %s without upstream accounting", async (path, status) => {
  const app = await createPool("http://127.0.0.1:1");
  const prepare = vi.spyOn(oauthTransport, "prepareOAuthRequest")
    .mockRejectedValue(new ConfigError("Synthetic OAuth preparation failure", Number(status)));
  const results = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");
  try {
    const response = await postJson(app.url, String(path), body);
    expect(response.status).toBe(status);
    await response.text();
    expect(results).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileName: "A" }), null);
  } finally { prepare.mockRestore(); results.mockRestore(); }
});

it("does not count compact cache replay as upstream recovery", async () => {
  let requests = 0;
  const upstream = await startUpstream(async (req, res) => {
    for await (const _chunk of req) { /* Consume synthetic input. */ }
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"object":"response.compaction","output":[{"type":"compaction","encrypted_content":"synthetic-state"}]}');
  });
  const app = await createPool(upstream.url);
  const results = vi.spyOn(PrimaryFailoverState.prototype, "recordResult");
  try {
    for (let index = 0; index < 2; index++) {
      const response = await postJson(app.url, "/v1/responses/compact", body);
      expect(response.status).toBe(200);
      await response.text();
      await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    }
    expect(requests).toBe(1);
    expect(results).toHaveBeenCalledTimes(2);
    expect(results.mock.calls[0]?.[1]).toMatchObject({ status: 200 });
    expect(results.mock.calls[1]?.[1]).toBeNull();
  } finally { results.mockRestore(); }
});
