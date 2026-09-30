import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugCaptureWriter } from "../src/server/debug-capture.js";
import { RequestLogger } from "../src/server/logger.js";
import { PrimaryFailoverState } from "../src/server/primary-failover.js";
import { injectFileCommitFault } from "./helpers/file-commit-fault.js";
import { startApp, openSseStream } from "./helpers/server-test-utils.js";

afterEach(() => vi.restoreAllMocks());

describe("committed configuration failures at the HTTP boundary", () => {
  it("reports failure but synchronizes logging, captures and the public snapshot", async () => {
    const app = await startApp();
    const events = await openSseStream(`${app.url}/api/events`);
    await events.waitForEvent("snapshot");
    const logging = vi.spyOn(RequestLogger.prototype, "configure");
    const captures = vi.spyOn(DebugCaptureWriter.prototype, "configure");
    const before = app.config.revision;
    injectFileCommitFault(app.config.getConfigPath(), "directory-sync");
    const response = await fetch(`${app.url}/api/config`, { method: "PATCH", body: JSON.stringify({ logging: { keep_recent: 23 } }) });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("was committed") });
    expect(app.config.revision).not.toBe(before);
    expect(JSON.parse(await readFile(app.config.getConfigPath(), "utf8")).logging.keep_recent).toBe(23);
    expect(logging).toHaveBeenCalledWith(expect.objectContaining({ keepRecent: 23 }));
    expect(captures).toHaveBeenCalled();
    expect(await events.waitForEvent("snapshot")).toMatchObject({ config: { logging: { keep_recent: 23 } } });
    await events.close();
  });

  it("still applies manual profile selection after its rename committed", async () => {
    const app = await startApp();
    await app.config.saveProfile("codex", "synthetic", {});
    const profile = app.config.get().profile_scopes?.codex?.profiles?.[0];
    if (!profile) throw new Error("Missing saved profile");
    const id = profile.id;
    const select = vi.spyOn(PrimaryFailoverState.prototype, "forceNextProfileSelection");
    injectFileCommitFault(app.config.getConfigPath(), "directory-sync");
    const response = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST", body: JSON.stringify({ scope: "codex", profile_id: id })
    });
    expect(response.status).toBe(500);
    await response.text();
    expect(select).toHaveBeenCalledWith(app.config.get(), id);
    expect(app.config.get().profile_scopes!.codex!.active_profile_id).toBe(id);
  });

  it("rejects opaque browser writes without changing the config", async () => {
    const app = await startApp();
    const before = app.config.revision;
    const response = await fetch(`${app.url}/api/config`, {
      method: "PATCH", headers: { origin: "null", "content-type": "text/plain" },
      body: JSON.stringify({ logging: { keep_recent: 23 } })
    });
    expect(response.status).toBe(403);
    await response.text();
    expect(app.config.revision).toBe(before);
  });
});
