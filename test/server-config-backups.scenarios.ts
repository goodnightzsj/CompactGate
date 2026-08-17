import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  cleanupEnvKeys,
  startApp
} from "./helpers/server-test-lifecycle.js";

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
  for (const key of cleanupEnvKeys) {
    delete process.env[key];
  }
  cleanupEnvKeys.clear();
});

describe("config backup API", () => {
  it("lists, restores, and deletes backups with explicit confirmation", async () => {
    const app = await startApp();
    const patch = async (keepRecent: number) => fetch(`${app.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logging: { keep_recent: keepRecent } })
    });

    expect((await patch(11)).status).toBe(200);
    expect((await patch(22)).status).toBe(200);

    const listResponse = await fetch(`${app.url}/api/config/backups`);
    const listBody = await listResponse.json() as {
      backups: Array<{ id: string; created_at: string; size_bytes: number }>;
    };
    expect(listResponse.status).toBe(200);
    expect(listBody.backups.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(listBody)).not.toContain("api_key");

    const backupId = listBody.backups.at(-1)!.id;
    const missingConfirm = await fetch(`${app.url}/api/config/backups/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backup_id: backupId })
    });
    expect(missingConfirm.status).toBe(400);

    const restoreResponse = await fetch(`${app.url}/api/config/backups/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backup_id: backupId, confirm: true })
    });
    const restored = await restoreResponse.json() as { logging: { keep_recent: number } };
    expect(restoreResponse.status).toBe(200);
    expect(restored.logging.keep_recent).not.toBe(22);

    const deleteResponse = await fetch(`${app.url}/api/config/backups`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backup_id: backupId, confirm: true })
    });
    expect(deleteResponse.status).toBe(200);
    await expect(fetch(`${app.url}/api/config/backups/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backup_id: backupId, confirm: true })
    })).resolves.toMatchObject({ status: 400 });
  });
});
