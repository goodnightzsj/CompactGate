import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyClientIdentityUserAgent,
  isNativeClaudeUserAgent,
  isNativeCliRequest,
  isNativeCodexUserAgent,
  stripUserAgentVariants,
  swapUserAgentVersion
} from "../src/server/client-identity.js";
import {
  ClientIdentityStore,
  ClientIdentityValueError,
  resolveClientIdentityStatePath
} from "../src/server/client-identity-store.js";
import { factoryClientUserAgent } from "../src/server/config-defaults.js";

const temporaryDirectories: string[] = [];
const openStores: ClientIdentityStore[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  // Close before removing: a store still running would re-create its state file
  // inside a directory being torn down.
  for (const store of openStores.splice(0)) {
    store.close();
    await store.flush();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** Every CLI User-Agent shape observed in this project's own request log. */
const OBSERVED_CODEX_AGENTS = [
  "codex-tui/0.144.1-cometix (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.1-cometix)",
  "codex-cli/0.144.3",
  "codex_exec/0.144.1-cometix (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex_exec; 0.144.1-cometix)",
  "codex_cli_rs/0.144.1-cometix (Mac OS 15.0.1; arm64) iTerm.app/3.6.11"
];

const OBSERVED_THIRD_PARTY_AGENTS = [
  "pi (darwin 24.0.0; arm64)",
  "curl/8.7.1",
  "Bun/1.4.1",
  "deepseek-harness/0.1.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
];

describe("client identity detection", () => {
  it("recognises every observed Codex CLI product token", () => {
    for (const userAgent of OBSERVED_CODEX_AGENTS) {
      expect(isNativeCodexUserAgent(userAgent), userAgent).toBe(true);
    }
  });

  it("recognises the Claude Code CLI and nothing that merely mentions Claude", () => {
    expect(isNativeClaudeUserAgent("claude-cli/2.1.234 (external, cli)")).toBe(true);
    expect(isNativeClaudeUserAgent("claude-cli/2.0.0 (external, cli)")).toBe(true);
    expect(isNativeClaudeUserAgent("my-claude-app/1.0.0")).toBe(false);
    expect(isNativeClaudeUserAgent("Anthropic SDK claude 2.1.234")).toBe(false);
    expect(isNativeClaudeUserAgent(null)).toBe(false);
  });

  it("treats third-party clients as rewritable for both families", () => {
    for (const userAgent of OBSERVED_THIRD_PARTY_AGENTS) {
      expect(isNativeCliRequest("codex", { "user-agent": userAgent }), userAgent).toBe(false);
      expect(isNativeCliRequest("claude", { "user-agent": userAgent }), userAgent).toBe(false);
    }
    expect(isNativeCliRequest("codex", {})).toBe(false);
  });
});

describe("user agent rewriting", () => {
  it("strips fork build tags from every version in the agent", () => {
    expect(
      stripUserAgentVariants(
        "codex-tui/0.144.3-cometix (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.3-cometix)"
      )
    ).toBe("codex-tui/0.144.3 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.3)");
    expect(stripUserAgentVariants("codex-cli/0.144.3")).toBe("codex-cli/0.144.3");
    expect(stripUserAgentVariants("claude-cli/2.1.234 (external, cli)"))
      .toBe("claude-cli/2.1.234 (external, cli)");
  });

  it("swaps only the product's own version, never the OS or terminal version", () => {
    expect(
      swapUserAgentVersion(
        "codex-tui/0.144.3 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.3)",
        "0.153.2"
      )
    ).toBe("codex-tui/0.153.2 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.2)");
    expect(swapUserAgentVersion("claude-cli/2.1.234 (external, cli)", "2.1.260"))
      .toBe("claude-cli/2.1.260 (external, cli)");
    expect(swapUserAgentVersion("codex_cli_rs/0.144.1 (Mac OS 15.0.1; arm64)", "0.153.2"))
      .toBe("codex_cli_rs/0.153.2 (Mac OS 15.0.1; arm64)");
  });

  it("refuses a version that is not a bare semver", () => {
    const agent = "codex-cli/0.144.3";
    expect(swapUserAgentVersion(agent, "0.153.2-beta")).toBe(agent);
    expect(swapUserAgentVersion(agent, "latest")).toBe(agent);
  });

  it("writes only user-agent and yields to an extra_headers override", () => {
    const headers = {
      accept: "*/*",
      "user-agent": "pi (darwin 24.0.0; arm64)",
      originator: "third-party",
      "anthropic-beta": "claude-code-20250219"
    };

    expect(applyClientIdentityUserAgent(headers, "codex-cli/0.153.2")).toBe(true);
    expect(headers).toEqual({
      accept: "*/*",
      "user-agent": "codex-cli/0.153.2",
      originator: "third-party",
      "anthropic-beta": "claude-code-20250219"
    });

    expect(applyClientIdentityUserAgent(headers, "codex-cli/9.9.9", ["User-Agent"])).toBe(false);
    expect(headers["user-agent"]).toBe("codex-cli/0.153.2");
    expect(applyClientIdentityUserAgent(headers, null)).toBe(false);
  });
});

describe("client identity store", () => {
  it("serves the factory agent before anything is observed", async () => {
    const store = await createStore();
    expect(store.userAgentFor("codex")).toBe(factoryClientUserAgent("codex"));
    expect(store.userAgentFor("claude")).toBe(factoryClientUserAgent("claude"));
    // `extracted` is preferred but empty, so the fallback has to be flagged.
    expect(store.status().resolved.codex).toMatchObject({
      source: "version_tracked",
      fell_back: true
    });
  });

  it("extracts once per day, strips the fork tag, and prefers the extracted agent", async () => {
    // Local-time constructors, because the day gate is a calendar day in local
    // time — UTC literals would make this test pass or fail by timezone.
    let now = localTime(2026, 9, 4, 1);
    const store = await createStore({ now: () => now });

    store.observeCliUserAgent("codex", OBSERVED_CODEX_AGENTS[0]);
    await store.flush();
    expect(store.userAgentFor("codex")).toBe(
      "codex-tui/0.144.1 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.144.1)"
    );
    expect(store.status().resolved.codex).toMatchObject({
      source: "extracted",
      fell_back: false
    });

    // Same day: a newer CLI build must not displace today's successful extraction.
    now = localTime(2026, 9, 4, 23);
    store.observeCliUserAgent("codex", "codex-cli/0.150.0");
    await store.flush();
    expect(store.userAgentFor("codex")).toContain("0.144.1");

    now = localTime(2026, 9, 5, 1);
    store.observeCliUserAgent("codex", "codex-cli/0.150.0");
    await store.flush();
    expect(store.userAgentFor("codex")).toBe("codex-cli/0.150.0");
  });

  it("applies the registry version to the version-tracked agent only", async () => {
    const store = await createStore({
      fetchLatestVersion: async (kind) => (kind === "codex" ? "0.153.2" : "2.1.260")
    });

    await store.refreshNow();
    await store.update({ codex: { preferred: "version_tracked" } });

    expect(store.userAgentFor("codex")).toBe(
      "codex-tui/0.153.2 (Mac OS 15.0.1; arm64) iTerm.app/3.6.11 (codex-tui; 0.153.2)"
    );
    expect(store.status().codex.remote_version).toBe("0.153.2");
    expect(store.status().claude.remote_version).toBe("2.1.260");
    // The stored value keeps its own version; only the outbound view carries the
    // registry one, so the panel can show both without the store rewriting itself.
    expect(store.status().codex.version_tracked.user_agent)
      .toBe(factoryClientUserAgent("codex"));
    expect(store.status().codex.version_tracked.outbound_user_agent).toContain("0.153.2");
    expect(store.status().codex.extracted.outbound_user_agent).toBe("");
  });

  it("retries an hour after a failure and stops once the day has a success", async () => {
    let now = localTime(2026, 9, 4, 1);
    const attempts: string[] = [];
    let version: string | null = null;
    const store = await createStore({
      now: () => now,
      tickIntervalMs: 60_000,
      fetchLatestVersion: async (kind) => {
        attempts.push(`${kind}@${now.toISOString()}`);
        return version;
      }
    });

    expect(attempts).toHaveLength(2);
    expect(store.status().codex.version_tracked.last_error).not.toBeNull();

    // Ten minutes later nothing is owed yet: the retry gap is an hour.
    now = localTime(2026, 9, 4, 1, 10);
    await store.refreshDue();
    expect(attempts).toHaveLength(2);

    now = localTime(2026, 9, 4, 2, 30);
    version = "0.153.2";
    await store.refreshDue();
    expect(attempts).toHaveLength(4);
    expect(store.status().codex.version_tracked.last_success_date).toBe("2026-09-04");

    // Same calendar day, well past the retry gap: a success closes the day.
    now = localTime(2026, 9, 4, 23);
    await store.refreshDue();
    expect(attempts).toHaveLength(4);

    // Next day it is owed again.
    now = localTime(2026, 9, 5, 1);
    await store.refreshDue();
    expect(attempts).toHaveLength(6);
    await store.flush();
  });

  it("drops a registry version older than the TTL and lets the extracted agent win", async () => {
    let now = localTime(2026, 9, 4, 1);
    const store = await createStore({
      now: () => now,
      fetchLatestVersion: async () => "0.153.2"
    });

    await store.refreshNow("codex");
    await store.update({ codex: { preferred: "version_tracked" } });
    expect(store.userAgentFor("codex")).toContain("0.153.2");

    now = localTime(2026, 9, 12, 1);
    expect(store.status().resolved.codex.remote_version_stale).toBe(true);
    // Nothing observed yet, so the stored agent still serves — just without the
    // expired version applied. Sending no user-agent at all would be worse.
    expect(store.userAgentFor("codex")).toBe(factoryClientUserAgent("codex"));

    store.observeCliUserAgent("codex", "codex-cli/0.144.3");
    await store.flush();
    expect(store.userAgentFor("codex")).toBe("codex-cli/0.144.3");
    expect(store.status().resolved.codex.fell_back).toBe(true);
  });

  it("freezes a hand-edited agent against both observation and the registry", async () => {
    let now = localTime(2026, 9, 4, 1);
    const store = await createStore({
      now: () => now,
      fetchLatestVersion: async () => "0.153.2"
    });

    await store.update({ codex: { extracted_user_agent: "codex-cli/1.2.3" } });
    expect(store.userAgentFor("codex")).toBe("codex-cli/1.2.3");

    now = localTime(2026, 9, 5, 1);
    store.observeCliUserAgent("codex", "codex-cli/0.150.0");
    expect(store.userAgentFor("codex")).toBe("codex-cli/1.2.3");

    await store.update({ codex: { version_tracked_user_agent: "codex-tui/7.7.7" } });
    await store.refreshNow("codex");
    await store.update({ codex: { preferred: "version_tracked" } });
    expect(store.userAgentFor("codex")).toBe("codex-tui/7.7.7");

    // Reverting to automatic re-opens both paths.
    await store.update({ codex: { extracted_user_agent: null } });
    now = localTime(2026, 9, 6, 1);
    store.observeCliUserAgent("codex", "codex-cli/0.151.0");
    await store.flush();
    expect(store.status().codex.extracted.user_agent).toBe("codex-cli/0.151.0");
  });

  it("rejects an agent that could inject a header or blow up the request", async () => {
    const store = await createStore();
    for (const value of ["evil\r\nx-admin: 1", "codex-cli/1.0.0\n", "bad\u0000", "bad\u007f", "bad\u0100"]) {
      await expect(store.update({ codex: { extracted_user_agent: value } }))
        .rejects.toBeInstanceOf(ClientIdentityValueError);
    }
    await expect(store.update({ codex: { extracted_user_agent: "a".repeat(600) } }))
      .rejects.toBeInstanceOf(ClientIdentityValueError);
    expect(store.status().codex.extracted.user_agent).toBe("");

    await store.update({ codex: { extracted_user_agent: "codex-cli/1.0.0\t(caf\u00e9)" } });
    expect(store.userAgentFor("codex")).toBe("codex-cli/1.0.0\t(caf\u00e9)");
  });

  it("stops rewriting entirely when disabled", async () => {
    const store = await createStore();
    await store.update({ enabled: false });
    expect(store.userAgentFor("codex")).toBeNull();
    expect(store.userAgentFor("claude")).toBeNull();
  });

  it("round-trips through the state file and rejects a corrupt one", async () => {
    const dir = await temporaryDir();
    const statePath = resolveClientIdentityStatePath(path.join(dir, "compactgate.json"));
    const store = new ClientIdentityStore({
      statePath,
      fetchLatestVersion: async () => null
    });
    await store.start();
    store.observeCliUserAgent("claude", "claude-cli/2.1.240 (external, cli)");
    await store.update({ claude: { preferred: "version_tracked" } });
    await store.flush();

    const reloaded = new ClientIdentityStore({ statePath, fetchLatestVersion: async () => null });
    await reloaded.start();
    expect(reloaded.status().claude.extracted.user_agent)
      .toBe("claude-cli/2.1.240 (external, cli)");
    expect(reloaded.status().claude.preferred).toBe("version_tracked");
    reloaded.close();
    store.close();

    // Operator settings must not be reset or overwritten when the file is damaged.
    await writeFile(statePath, "{ not json");
    const recovered = new ClientIdentityStore({ statePath, fetchLatestVersion: async () => null });
    await expect(recovered.start()).rejects.toThrow("Could not load client identity state");
    expect(await readFile(statePath, "utf8")).toBe("{ not json");
    recovered.close();
  });

  it("preserves manual empty sources and pinned versions after reload", async () => {
    const dir = await temporaryDir();
    const statePath = path.join(dir, "client-identity.json");
    const options = { statePath, fetchLatestVersion: async () => "9.9.9" };
    const store = new ClientIdentityStore(options);
    openStores.push(store);
    await store.start();
    await store.update({
      codex: { extracted_user_agent: "", version_tracked_user_agent: "" },
      claude: { preferred: "version_tracked", version_tracked_user_agent: "claude-cli/2.0.0" }
    });
    store.close();

    const reloaded = new ClientIdentityStore(options);
    openStores.push(reloaded);
    await reloaded.start();
    expect(reloaded.status()).toEqual(store.status());
    expect(reloaded.userAgentFor("codex")).toBeNull();
    expect(reloaded.userAgentFor("claude")).toBe("claude-cli/2.0.0");
  });

  it.each(["null", '{"enabled":"false"}', '{"codex":{"preferred":"other"}}',
    '{"codex":{"extracted":{"manual":true,"user_agent":"bad\\u007f"}}}'])
  ("rejects malformed stored settings without replacing them: %s", async (raw) => {
    const statePath = path.join(await temporaryDir(), "client-identity.json");
    await writeFile(statePath, raw);
    const store = new ClientIdentityStore({ statePath, fetchLatestVersion: async () => null });
    openStores.push(store);
    await expect(store.start()).rejects.toThrow("Could not load client identity state");
    expect(await readFile(statePath, "utf8")).toBe(raw);
  });

  it("rejects unreadable state paths rather than resetting settings", async () => {
    const store = new ClientIdentityStore({ statePath: await temporaryDir() });
    openStores.push(store);
    await expect(store.load()).rejects.toMatchObject({ cause: { code: "EISDIR" } });
  });

  it("does not let an in-flight registry response overwrite a newer manual edit", async () => {
    const pending = deferred<string | null>();
    const next = new ClientIdentityStore({
      statePath: path.join(await temporaryDir(), "client-identity.json"),
      fetchLatestVersion: () => pending.promise
    });
    openStores.push(next);
    await next.load();
    const refresh = next.refreshNow("codex");
    await next.update({ codex: { version_tracked_user_agent: "codex-cli/2.0.0" } });
    const before = next.status();
    pending.resolve("9.9.9");
    await refresh;
    expect(next.status()).toEqual(before);
  });

  it("rejects failed writes and allows the next update to retry", async () => {
    const dir = await temporaryDir();
    const statePath = path.join(dir, "client-identity.json");
    const store = new ClientIdentityStore({ statePath, fetchLatestVersion: async () => "9.9.9" });
    openStores.push(store);
    await store.start();
    const saved = await readFile(statePath, "utf8");
    const before = store.status();
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    await mkdir(temporaryPath);
    try {
      await expect(store.update({ enabled: false })).rejects.toMatchObject({ code: "EISDIR" });
      await expect(store.flush()).rejects.toMatchObject({ code: "EISDIR" });
      await expect(store.refreshNow("codex")).rejects.toMatchObject({ code: "EISDIR" });
      const failed = await Promise.allSettled([
        store.update({ enabled: false }),
        store.update({ codex: { extracted_user_agent: "codex-cli/8.8.8" } })
      ]);
      expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(store.status()).toEqual(before);
      expect(await readFile(statePath, "utf8")).toBe(saved);
    } finally {
      await rm(temporaryPath, { recursive: true, force: true });
      await store.update({ enabled: true });
    }
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ enabled: true });
  });

  it("merges concurrent successful updates with automatic observations", async () => {
    const store = await createStore();
    const updates = Promise.all([
      store.update({ enabled: false }),
      store.update({ codex: { extracted_user_agent: "codex-cli/2.3.4" } })
    ]);
    store.observeCliUserAgent("claude", "claude-cli/3.4.5");
    await updates;
    await store.flush();
    expect(store.status()).toMatchObject({
      enabled: false,
      codex: { extracted: { user_agent: "codex-cli/2.3.4", manual: true } },
      claude: { extracted: { user_agent: "claude-cli/3.4.5", manual: false } }
    });
  });

  it("notifies subscribers when automatic state changes are persisted", async () => {
    let now = localTime(2026, 9, 4, 1);
    const store = await createStore({ now: () => now, fetchLatestVersion: async () => "9.9.9" });
    const updates: string[] = [];
    const unsubscribe = store.subscribe(() => updates.push(store.status().codex.extracted.user_agent));
    store.observeCliUserAgent("codex", "codex-cli/1.2.3");
    await store.flush();
    expect(updates).toEqual(["codex-cli/1.2.3"]);

    now = localTime(2026, 9, 5, 1);
    await store.refreshDue();
    expect(updates).toHaveLength(3);
    unsubscribe();
    store.observeCliUserAgent("codex", "codex-cli/1.2.4");
    await store.flush();
    expect(updates).toHaveLength(3);
  });

  it("reports background write failures without an unhandled rejection", async () => {
    const dir = await temporaryDir();
    const store = new ClientIdentityStore({ statePath: path.join(dir, "missing", "state.json") });
    openStores.push(store);
    await store.load();
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      store.observeCliUserAgent("codex", "codex-cli/1.2.3");
      await expect(store.flush()).rejects.toMatchObject({ code: "ENOENT" });
      await vi.waitFor(() => expect(report).toHaveBeenCalled());
      await mkdir(path.join(dir, "missing"));
      await store.update({ enabled: false });
    } finally {
      report.mockRestore();
    }
  });

  it("writes no state file after close", async () => {
    const dir = await temporaryDir();
    const statePath = resolveClientIdentityStatePath(path.join(dir, "compactgate.json"));
    const store = new ClientIdentityStore({ statePath, fetchLatestVersion: async () => null });
    store.close();
    store.observeCliUserAgent("codex", "codex-cli/0.144.3");
    await store.flush();
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
  });
});

async function createStore(options: {
  now?: () => Date;
  fetchLatestVersion?: (kind: "codex" | "claude") => Promise<string | null>;
  tickIntervalMs?: number;
} = {}): Promise<ClientIdentityStore> {
  const dir = await temporaryDir();
  const store = new ClientIdentityStore({
    statePath: resolveClientIdentityStatePath(path.join(dir, "compactgate.json")),
    fetchLatestVersion: options.fetchLatestVersion ?? (async () => null),
    now: options.now,
    tickIntervalMs: options.tickIntervalMs
  });
  openStores.push(store);
  await store.start();
  return store;
}

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-identity-"));
  temporaryDirectories.push(dir);
  return dir;
}

/** Local-time `Date`, so day-boundary assertions do not depend on the host zone. */
function localTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}
