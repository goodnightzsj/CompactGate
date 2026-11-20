import { EventEmitter } from "node:events";
import { get, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import { startApp } from "./helpers/server-test-utils.js";

afterEach(() => vi.useRealTimers());

it("delivers a legal 2000-row snapshot over 8 MiB to reading clients", async () => {
  const app = await startApp(undefined, undefined, { logging: { keep_recent: 2000 } });
  const writer = new DatabaseSync(path.join(app.dir, "compactgate-logs.sqlite"));
  try {
    writer.prepare(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 2000)
      INSERT INTO request_logs(time, route, method, path, status, duration_ms, upstream_host, request_id, user_agent)
      SELECT '2026-11-20T00:00:00.000Z', 'primary', 'POST', '/v1/responses', 200, 1, 'fixture.invalid', CAST(n AS TEXT), ? FROM rows`)
      .run(`synthetic/${"x".repeat(2048)}`);
  } finally { writer.close(); }
  for (let attempt = 0; attempt < 2; attempt++) {
    const frame = await firstFrame(`${app.url}/api/events`);
    expect(Buffer.byteLength(frame)).toBeGreaterThan(8 * 1024 * 1024);
    const payload = JSON.parse(frame.split("\ndata: ")[1]);
    expect(payload.logs).toHaveLength(2000);
    expect(payload.log_page.logs).toEqual(payload.logs);
  }
});

it("keeps frame ordering and byte integrity while draining a large frame", () => {
  const { broadcaster, req, res, chunks } = blockedClient();
  const snapshot = { synthetic: "中😀".repeat(1_500_000) };
  broadcaster.subscribe(req, res, snapshot as never);
  broadcaster.broadcastKeyActivity("codex", "profile", "key", "revision");
  expect(chunks).toHaveLength(1);
  for (let count = 0; res.listenerCount("drain") && count < 1000; count++) res.emit("drain");
  const frames = Buffer.concat(chunks).toString().trim().split("\n\n");
  expect(frames).toHaveLength(2);
  expect(JSON.parse(frames[0].split("\ndata: ")[1])).toEqual(snapshot);
  expect(frames[1]).toContain("event: key_activity");
  expect(chunks.every(chunk => chunk.length <= 64 * 1024)).toBe(true);
  broadcaster.close();
  expect(res.listenerCount("drain")).toBe(0);
  expect(req.listenerCount("close")).toBe(0);
});

it("reaps an unread single frame after its drain deadline and frees admission", () => {
  vi.useFakeTimers();
  const { broadcaster, req, res } = blockedClient();
  broadcaster.subscribe(req, res, { synthetic: "x".repeat(9 * 1024 * 1024) } as never);
  vi.advanceTimersByTime(29_999);
  expect(res.destroyed).toBe(false);
  vi.advanceTimersByTime(1);
  expect(res.destroyed).toBe(true);
  expect(res.listenerCount("drain")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  const next = blockedClient();
  broadcaster.subscribe(next.req, next.res, {} as never);
  expect(next.chunks).toHaveLength(1);
  broadcaster.close();
});

function blockedClient() {
  const broadcaster = new StudioEventBroadcaster({ maxClients: 1 });
  const chunks: Buffer[] = [];
  const req = new EventEmitter() as IncomingMessage;
  const events = new EventEmitter();
  const res = Object.assign(events, {
    destroyed: false, writableEnded: false,
    writeHead: vi.fn(), flushHeaders: vi.fn(),
    write(chunk: Buffer) { chunks.push(Buffer.from(chunk)); return false; },
    end() { this.writableEnded = true; events.emit("close"); },
    destroy() { this.destroyed = true; events.emit("close"); }
  }) as unknown as ServerResponse;
  return { broadcaster, req, res, chunks };
}

function firstFrame(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const request = get(url, response => {
      response.on("data", chunk => {
        chunks.push(chunk);
        const tail = chunk.subarray(-2).toString();
        if (tail === "\n\n") {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString());
          request.destroy();
        }
      });
      response.once("error", reject);
    });
    request.once("error", reject);
    const timer = setTimeout(() => { request.destroy(); reject(new Error("Snapshot did not complete.")); }, 4000);
  });
}
