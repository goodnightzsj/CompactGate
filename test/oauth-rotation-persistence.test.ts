import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { OAuthStore } from "../src/server/oauth-store.js";
import { oauthTestProvider } from "./helpers/oauth-test-provider.js";
import { makeConfigDir } from "./helpers/config-test-utils.js";
import { injectFileCommitFault } from "./helpers/file-commit-fault.js";
import * as repository from "../src/server/config-file-repository.js";

afterEach(() => vi.restoreAllMocks());

it.each(["none", "file-chmod", "file-sync", "directory-sync"] as const)(
  "retains accepted rotation after a one-shot persistence fault: %s", async stage => {
    const dir = await makeConfigDir();
    const file = path.join(dir, "synthetic-oauth.json");
    const issuer = oauthTestProvider("qwen-code");
    const store = await OAuthStore.load(path.join(dir, "synthetic.json"), issuer);
    const id = await issuer.authorize(store);
    let grant = "synthetic-refresh";
    let generation = 0;
    const attempts: string[] = [];
    issuer.fetcher.mockImplementation(async (_url, options) => {
      const submitted = new URLSearchParams(String(options?.body)).get("refresh_token") ?? "";
      attempts.push(submitted);
      if (submitted !== grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
      grant = `synthetic-rotated-${++generation}`;
      return Response.json({ access_token: `synthetic-access-${generation}`, refresh_token: grant,
        expires_in: 3600, resource_url: "https://portal.qwen.ai" });
    });
    const fault = stage === "none" ? null : injectFileCommitFault(file, stage);
    try {
      const error = await store.refresh(id).then(() => null, reason => reason);
      if (stage === "directory-sync") expect(error).toMatchObject({ name: "FileCommitError", cause: fault });
      else expect(error).toBe(fault);
      expect(attempts).toEqual(["synthetic-refresh"]);
      expect(JSON.parse(await readFile(file, "utf8")).accounts[0].refresh_token).toBe("synthetic-rotated-1");
      await store.refresh(id);
      expect(attempts).toEqual(["synthetic-refresh", "synthetic-rotated-1"]);
      expect(store.status(id)).toBe("connected");
      await store.flush();
    } finally { store.close(); }
  }
);

it("preserves both commit failures without a third write of the old grant", async () => {
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(path.join(await makeConfigDir(), "synthetic.json"), issuer);
  const id = await issuer.authorize(store);
  issuer.fetcher.mockResolvedValueOnce(Response.json({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-grant",
    expires_in: 3600, resource_url: "https://portal.qwen.ai" }));
  const original = new Error("synthetic first commit failure");
  const recovery = new Error("synthetic recovery commit failure");
  const write = vi.spyOn(repository, "writeFileAtomically").mockRejectedValueOnce(original).mockRejectedValueOnce(recovery);
  try {
    const error = await store.refresh(id).catch(reason => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([original, recovery]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.every(([, body]) => String(body).includes("synthetic-new-grant"))).toBe(true);
    await expect(store.flush()).rejects.toBe(error);
    const exchanges = issuer.fetcher.mock.calls.length;
    await expect(store.credentials(id)).resolves.toMatchObject({ refresh_token: "synthetic-new-grant" });
    expect(issuer.fetcher).toHaveBeenCalledTimes(exchanges);
    await store.flush();
  } finally { store.close(); }
});

it("does not hide an unpersisted rotation after a different account commits", async () => {
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(path.join(await makeConfigDir(), "synthetic.json"), issuer);
  const id = await issuer.authorize(store);
  const otherId = await issuer.authorize(store);
  issuer.fetcher.mockResolvedValueOnce(Response.json({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-grant",
    expires_in: 3600, resource_url: "https://portal.qwen.ai" }));
  vi.spyOn(repository, "writeFileAtomically").mockRejectedValueOnce(new Error("synthetic commit failure"))
    .mockRejectedValueOnce(new Error("synthetic recovery failure"));
  try {
    await expect(store.refresh(id)).rejects.toBeInstanceOf(AggregateError);
    await store.disconnect(otherId);
    await expect(store.flush()).rejects.toThrow("Rotated OAuth credentials remain unpersisted");
    const exchanges = issuer.fetcher.mock.calls.length;
    await expect(store.credentials(id)).resolves.toMatchObject({ refresh_token: "synthetic-new-grant" });
    expect(issuer.fetcher).toHaveBeenCalledTimes(exchanges);
    await store.flush();
  } finally { store.close(); }
});

it.each([false, true])("clears pending rotation only after a committed disconnect, failed=%s", async failed => {
  const issuer = oauthTestProvider("qwen-code");
  const store = await OAuthStore.load(path.join(await makeConfigDir(), "synthetic.json"), issuer);
  const id = await issuer.authorize(store);
  issuer.fetcher.mockResolvedValueOnce(Response.json({ access_token: "synthetic-new-access", refresh_token: "synthetic-new-grant",
    expires_in: 3600, resource_url: "https://portal.qwen.ai" }));
  const write = vi.spyOn(repository, "writeFileAtomically").mockRejectedValueOnce(new Error("synthetic commit failure"))
    .mockRejectedValueOnce(new Error("synthetic recovery failure"));
  try {
    await expect(store.refresh(id)).rejects.toBeInstanceOf(AggregateError);
    const exchanges = issuer.fetcher.mock.calls.length;
    if (failed) {
      const error = new Error("synthetic disconnect commit failure");
      write.mockRejectedValueOnce(error);
      await expect(store.disconnect(id)).rejects.toBe(error);
      await expect(store.credentials(id)).resolves.toMatchObject({ refresh_token: "synthetic-new-grant" });
    } else {
      await store.disconnect(id);
      await expect(store.credentials(id)).rejects.toThrow("disconnected");
      expect(store.status(id)).toBe("disconnected");
    }
    expect(issuer.fetcher).toHaveBeenCalledTimes(exchanges);
    await store.flush();
  } finally { store.close(); }
});
