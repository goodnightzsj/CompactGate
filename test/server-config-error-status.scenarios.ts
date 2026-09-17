import { describe, expect, it } from "vitest";
import type { PublicConfig } from "../src/shared/types.js";
import { fetchJson, startApp } from "./helpers/server-test-utils.js";

/**
 * The Studio has to tell a lost write apart from a rejected payload to offer the
 * "save my draft anyway" override, and it can only do that from the status code.
 */
describe("CompactGate config API error statuses", () => {
  it("exports only the snapshot matching the draft revision while keeping saved-only export compatible", async () => {
    const app = await startApp();
    const { body: original } = await fetchJson<PublicConfig>(`${app.url}/api/config`, "GET");
    const pinnedUrl = `${app.url}/api/config/export?revision=${encodeURIComponent(original.revision)}`;
    expect((await fetch(pinnedUrl)).status).toBe(200);
    await fetchJson(`${app.url}/api/config`, "PATCH", {
      primary: { base_url: "https://synthetic-b.example/v1", api_key: "SYNTHETIC_B" }
    });
    const stale = await fetch(pinnedUrl);
    expect(stale.status).toBe(409);
    expect(await stale.text()).not.toContain("SYNTHETIC_B");
    const saved = await fetch(`${app.url}/api/config/export`);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ primary: {
      base_url: "https://synthetic-b.example/v1", api_key: "SYNTHETIC_B"
    } });
  });

  it("separates a lost write, a missing profile and a bad payload", async () => {
    const app = await startApp();

    const { body: current } = await fetchJson<PublicConfig>(`${app.url}/api/config`, "GET");
    const staleRevision = current.revision;
    const { response: firstWrite } = await fetchJson<PublicConfig>(`${app.url}/api/config`, "PATCH", {
      revision: staleRevision,
      logging: { keep_recent: 411 }
    });
    expect(firstWrite.status).toBe(200);

    const { response: conflict, body: conflictBody } = await fetchJson<{ error: string }>(
      `${app.url}/api/config`,
      "PATCH",
      { revision: staleRevision, logging: { keep_recent: 412 } }
    );
    expect(conflict.status).toBe(409);
    expect(conflictBody.error).toMatch(/superseded revision/i);

    const { response: missingProfile, body: missingProfileBody } = await fetchJson<{ error: string }>(
      `${app.url}/api/config/profiles/apply`,
      "POST",
      { scope: "codex", profile_id: "does-not-exist" }
    );
    expect(missingProfile.status).toBe(404);
    expect(missingProfileBody.error).toBe("Profile not found.");

    const { response: badPayload } = await fetchJson<{ error: string }>(
      `${app.url}/api/config`,
      "PATCH",
      { logging: { keep_recent: 0 } }
    );
    expect(badPayload.status).toBe(400);
  });
});
