import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderStateRecoveryStore, recoveryHash, type ProviderStateCheckpoint, type ProviderStateRecoveryPolicy } from "../src/server/provider-state-recovery-store.js";
import { completedResponseOutput, rememberProviderCheckpoint, restoreProviderCheckpoint } from "../src/server/provider-state-checkpoints.js";
import type { BufferedUpstreamResult } from "../src/server/upstream-client.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function memoryStore() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return { db, store: new ProviderStateRecoveryStore(db) };
}
const policy: ProviderStateRecoveryPolicy = {
  base: "original", stripCompactionIds: false, priorEncryptedFailures: [], rejectedCompaction: true, unavailable: false,
  failure: { kind: "encrypted_content", code: "invalid_encrypted_content", evidence: "message", itemId: "private-item", inputIndex: 3, encryptedContentHash: "a".repeat(64) }
};
const user = { type: "message", role: "user", content: "remember the number 42" };
const state = { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque-synthetic-state" };
const checkpoint: ProviderStateCheckpoint = { window: [state], history: [user], fidelity: "exact", prefixHash: null };
function result(output: unknown[]): BufferedUpstreamResult {
  return { status: 200, errorSummary: null, responseBody: Buffer.from(JSON.stringify({ id: "resp_fixture", status: "completed", output })),
    responseBodyTruncated: false, responseHeaders: { "content-type": "application/json" }, firstTokenMs: 1, streamSummary: null, clientDisconnectPhase: "none" };
}

describe("persistent provider-state recovery", () => {
  it("ignores legacy negative rules without deleting them and never persists new ones", () => {
    const { db, store } = memoryStore();
    const negative = { ...policy, unavailable: true,
      failure: { ...policy.failure!, itemId: null, inputIndex: null } };
    db.prepare("INSERT INTO provider_state_recovery_plans VALUES (?, ?, ?, ?)")
      .run("legacy-negative", JSON.stringify(negative), 100, 1000);
    expect(store.findPolicy("legacy-negative", 101)).toBeNull();
    expect(store.rememberPolicy("new-negative", negative, 101, 101)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM provider_state_recovery_plans").get()?.n).toBe(1);
  });

  it("reports write failures explicitly without changing an already delivered response", () => {
    const { db } = memoryStore();
    const failures: unknown[] = [];
    const store = new ProviderStateRecoveryStore(db, error => failures.push(error));
    db.exec("DROP TABLE provider_state_recovery_plans; DROP TABLE provider_state_checkpoints");
    expect(store.rememberPolicy("policy", policy, 1)).toBe(false);
    expect(store.rememberCheckpoint("checkpoint", checkpoint, 1)).toBe(false);
    expect(failures).toHaveLength(2);
    expect(failures.every(error => error instanceof Error)).toBe(true);
  });

  it("fails closed on corrupted persisted data without echoing stored content", () => {
    const { db, store } = memoryStore();
    store.rememberCheckpoint("key", checkpoint, 1, 100);
    db.prepare("UPDATE provider_state_checkpoints SET snapshot = ?").run("secret-history-invalid-json");
    expect(() => store.findCheckpoint("key", 1, 101)).toThrow(/^Invalid persisted provider-state checkpoint\.$/);
    store.rememberPolicy("key", policy, 1, 100);
    db.prepare("UPDATE provider_state_recovery_plans SET policy = ?").run(JSON.stringify({ ...policy, failure: { ...policy.failure, itemId: null, inputIndex: null, encryptedContentHash: "not-a-hash" } }));
    expect(() => store.findPolicy("key", 101)).toThrow("Invalid persisted provider-state recovery policy.");
  });

  it("enforces the metadata entry cap and checkpoint byte cap", () => {
    const { db, store } = memoryStore();
    db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<8193)
      INSERT INTO provider_state_recovery_plans SELECT CAST(x AS TEXT), ?, x, 100000 FROM n`).run(JSON.stringify({ ...policy, failure: null }));
    store.rememberPolicy("latest", policy, 9000, 100);
    expect(db.prepare("SELECT count(*) AS n FROM provider_state_recovery_plans").get()?.n).toBe(8192);
    expect(store.findPolicy("1", 101)).toBeNull();
    const large = { ...checkpoint, history: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 - 1024) }] };
    for (let index = 0; index < 17; index++) expect(store.rememberCheckpoint(`large_${index}`, large, 1, 100 + index)).toBe(true);
    expect(Number(db.prepare("SELECT sum(bytes) AS n FROM provider_state_checkpoints").get()?.n)).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(store.findCheckpoint("large_0", 1, 200)).toBeNull();
    expect(store.findCheckpoint("large_16", 1, 200)).not.toBeNull();
  });
  it("stores bounded failure metadata without error text, item IDs or ciphertext", () => {
    const { store, db } = memoryStore();
    store.rememberPolicy(recoveryHash("session", "domain", "ciphertext"), policy, 2, 100);
    const serialized = JSON.stringify(db.prepare("SELECT * FROM provider_state_recovery_plans").all());
    expect(serialized).not.toContain("private-item");
    expect(serialized).not.toContain("ciphertext");
    expect(store.findPolicy(recoveryHash("session", "domain", "ciphertext"), 101)).toMatchObject({ unavailable: false, failure: { itemId: null, inputIndex: null } });
    expect(store.findPolicy(recoveryHash("other-session", "domain", "ciphertext"), 101)).toBeNull();
    expect(store.findPolicy(recoveryHash("session", "other-domain", "ciphertext"), 101)).toBeNull();
  });

  it("does not let a late old request overwrite a newer recovery decision", () => {
    const { store } = memoryStore();
    store.rememberPolicy("key", { ...policy, stripCompactionIds: true }, 20, 100);
    store.rememberPolicy("key", policy, 10, 101);
    expect(store.findPolicy("key", 102)?.stripCompactionIds).toBe(true);
    expect(store.findPolicy("key", 100 + 86_400_000)).toBeNull();
  });

  it("keeps content retention opt-in and revokes in-flight writes when disabled", () => {
    const { store, db } = memoryStore();
    expect(store.rememberCheckpoint("key", checkpoint, 0, 100)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM provider_state_checkpoints").get()?.n).toBe(0);
    store.configureRetention(24, 100);
    expect(store.rememberCheckpoint("key", checkpoint, 24, 100)).toBe(true);
    store.configureRetention(0, 101);
    expect(store.findCheckpoint("key", 24, 102)).toBeNull();
    expect(store.rememberCheckpoint("late", checkpoint, 24, 102)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM provider_state_checkpoints").get()?.n).toBe(0);
  });

  it("expires checkpoints and rejects oversized snapshots without truncating context", () => {
    const { store } = memoryStore();
    expect(store.rememberCheckpoint("key", checkpoint, 1, 100)).toBe(true);
    expect(store.findCheckpoint("key", 1, 3_600_099)).not.toBeNull();
    expect(store.findCheckpoint("key", 1, 3_600_100)).toBeNull();
    expect(store.rememberCheckpoint("large", { ...checkpoint, history: ["x".repeat(4 * 1024 * 1024)] }, 1, 100)).toBe(false);
    expect(store.findCheckpoint("large", 1, 101)).toBeNull();
  });

  it("preserves the first checkpoint for a state instead of overwriting its lineage", () => {
    const { store } = memoryStore();
    store.rememberCheckpoint("key", checkpoint, 1, 100);
    store.rememberCheckpoint("key", { ...checkpoint, history: [] }, 1, 101);
    expect(store.findCheckpoint("key", 1, 102)?.history).toEqual([user]);
  });

  it("recovers both metadata and content after reopening the SQLite database", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-recovery-test-"));
    try {
      const file = path.join(dir, "recovery.sqlite");
      const first = new DatabaseSync(file);
      const store = new ProviderStateRecoveryStore(first);
      store.rememberPolicy("policy", policy, 1, 100);
      store.rememberCheckpoint("checkpoint", checkpoint, 1, 100);
      first.close();
      const reopened = new DatabaseSync(file);
      try {
        const next = new ProviderStateRecoveryStore(reopened);
        expect(next.findPolicy("policy", 101)?.unavailable).toBe(false);
        expect(next.findCheckpoint("checkpoint", 1, 101)).toEqual(checkpoint);
      } finally { reopened.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("checkpoint context coverage", () => {
  it("replaces a complete V1 window without duplicating retained messages or losing tool results", () => {
    const { store } = memoryStore();
    const call = { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" };
    const tool = { type: "function_call_output", call_id: "call_1", output: "42" };
    expect(rememberProviderCheckpoint({ store, conversationHash: "session", retentionHours: 1,
      requestBody: Buffer.from(JSON.stringify({ input: [user, call, tool] })), result: result([user, state]), mode: "remote_v1" })).toBe(true);
    const next = { type: "message", role: "user", content: "what number?" };
    const restored = restoreProviderCheckpoint(store, "session", Buffer.from(JSON.stringify({ input: [user, state, next] })), 1);
    expect(JSON.parse(restored!.body.toString()).input).toEqual([user, call, tool, next]);
    expect(restoreProviderCheckpoint(store, "other", Buffer.from(JSON.stringify({ input: [user, state, next] })), 1)).toBeNull();
    expect(restoreProviderCheckpoint(store, "session", Buffer.from(JSON.stringify({ input: [state, next] })), 1)).toBeNull();
  });

  it("restores V2 after pruning while rejecting unrecognized content before the state", () => {
    const { store } = memoryStore();
    const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recorded." }] };
    expect(rememberProviderCheckpoint({ store, conversationHash: "session", retentionHours: 1,
      requestBody: Buffer.from(JSON.stringify({ input: [user] })), result: result([answer, state]), mode: "remote_v2" })).toBe(true);
    for (const prefix of [[], [user, answer]]) {
      const restored = restoreProviderCheckpoint(store, "session", Buffer.from(JSON.stringify({ input: [...prefix, state] })), 1);
      expect(JSON.parse(restored!.body.toString()).input).toEqual([user, answer]);
    }
    expect(restoreProviderCheckpoint(store, "session", Buffer.from(JSON.stringify({ input: [{ ...user, content: "new instruction" }, state] })), 1)).toBeNull();
  });

  it("matches the observed unpruned prefix after successive V2 compactions", () => {
    const { store } = memoryStore();
    const next = { type: "message", role: "user", content: "and remember 43" };
    const secondState = { ...state, id: "cmp_second", encrypted_content: "second-opaque-state" };
    expect(rememberProviderCheckpoint({ store, conversationHash: "session", retentionHours: 1,
      requestBody: Buffer.from(JSON.stringify({ input: [user] })), result: result([state]), mode: "remote_v2" })).toBe(true);
    expect(rememberProviderCheckpoint({ store, conversationHash: "session", retentionHours: 1,
      requestBody: Buffer.from(JSON.stringify({ input: [state, next] })), result: result([secondState]), mode: "remote_v2" })).toBe(true);
    for (const input of [[secondState], [state, next, secondState]]) {
      const restored = restoreProviderCheckpoint(store, "session", Buffer.from(JSON.stringify({ input })), 1);
      expect(JSON.parse(restored!.body.toString()).input).toEqual([user, next]);
    }
  });

  it.each(["disabled", "truncated", "incomplete", "missing-history"])("does not fabricate a checkpoint: %s", scenario => {
    const { store } = memoryStore();
    const response = result([state]);
    if (scenario === "truncated") response.responseBodyTruncated = true;
    if (scenario === "incomplete") response.responseBody = Buffer.from(JSON.stringify({ status: "in_progress", output: [state] }));
    expect(rememberProviderCheckpoint({ store, conversationHash: "session", retentionHours: scenario === "disabled" ? 0 : 1,
      requestBody: Buffer.from(JSON.stringify({ input: scenario === "missing-history" ? [state] : [user] })), result: response, mode: "remote_v2" })).toBe(false);
  });

  it("never mistakes a partial added item for a completed replay item", () => {
    const response = result([]);
    response.responseHeaders = { "content-type": "text/event-stream" };
    response.streamSummary = { sawTerminalEvent: true, sawCompletedEvent: true, sawFailedEvent: false, sawIncompleteEvent: false,
      sawOutputEvent: true, sawDoneMarker: false, terminalEvent: "response.completed", eventCount: 2, oversizedEventCount: 0,
      decodeError: false, errorSummary: null, responseModel: null, usage: null };
    response.responseBody = Buffer.from(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: state })}\n\ndata: {"type":"response.completed","response":{}}\n\n`);
    expect(completedResponseOutput(response)).toBeNull();
    response.responseBody = Buffer.from(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: state })}\n\ndata: {"type":"response.completed","response":{}}\n\n`);
    expect(completedResponseOutput(response)).toEqual([state]);
    response.responseBody = Buffer.from(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: state })}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n`);
    expect(completedResponseOutput(response)).toBeNull();
  });
});
