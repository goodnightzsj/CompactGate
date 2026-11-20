import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CaptureRecord,
  DebugCaptureWriter,
  serializeHeaders
} from "../src/server/debug-capture.js";
import { persistCapture } from "../src/server/proxy-support.js";

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat), readdir: vi.fn(fs.readdir), unlink: vi.fn(fs.unlink) };
});

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const clean = cleanup.pop();
    if (clean) {
      await clean();
    }
  }
});

describe("DebugCaptureWriter pruning", () => {
  const existingName = "compactgate-capture-0000-primary-v1-responses-00000000-0000-0000-0000-000000000000.json";

  it("reports write failure without rejecting the proxy finalizer", async () => {
    const dir = await makeCaptureDir();
    const invalidDir = path.join(dir, "ordinary-file");
    await writeFile(invalidDir, "fixture");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const writer = DebugCaptureWriter.fromConfig(invalidDir);
      await expect(persistCapture(writer, () => captureRecord("00000000-0000-0000-0000-000000000001"))).resolves.toBeNull();
      await writer.flush();
      expect(errors.mock.calls.some(([message]) => String(message).includes("write request capture"))).toBe(true);
    } finally { errors.mockRestore(); }
  });

  it.each(["stat", "unlink", "readdir", "notify"])("reports %s cleanup errors without rejecting background work", async operation => {
    const dir = await makeCaptureDir();
    const existing = path.join(dir, existingName);
    await writeFile(existing, Buffer.alloc(1024));
    const error = Object.assign(new Error("synthetic EACCES"), { code: "EACCES" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      if (operation === "stat") vi.mocked(stat).mockRejectedValueOnce(error);
      if (operation === "unlink") vi.mocked(unlink).mockRejectedValueOnce(error);
      if (operation === "readdir") vi.mocked(readdir).mockRejectedValueOnce(error);
      const writer = DebugCaptureWriter.fromConfig(dir, 1024, 1, () => { if (operation === "notify") throw error; });
      await expect(writer.flush()).resolves.toBeUndefined();
      expect(errors.mock.calls.some(call => call.includes(error))).toBe(true);
      expect(existsSync(existing)).toBe(operation !== "notify");
      if (operation === "stat") {
        await writer.write(captureRecord("00000000-0000-0000-0000-000000000001"));
        await writer.flush();
        expect(existsSync(existing)).toBe(false);
      }
    } finally { errors.mockRestore(); }
  });

  it("treats ENOENT during scanning as a normal deletion race", async () => {
    const dir = await makeCaptureDir();
    await writeFile(path.join(dir, existingName), "fixture");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
      const writer = DebugCaptureWriter.fromConfig(dir);
      await writer.flush();
      expect(errors).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });

  it("skips repeat scans for writes above 90% while the measured directory is still below the cap", async () => {
    const dir = await makeCaptureDir();
    await writeFile(path.join(dir, existingName), Buffer.alloc(100_000));
    const writer = DebugCaptureWriter.fromConfig(dir, 1024, 110_000);
    await writer.flush();
    vi.mocked(readdir).mockClear();
    vi.mocked(stat).mockClear();
    for (let i = 1; i <= 3; i++) {
      await writer.write(captureRecord(`00000000-0000-0000-0000-00000000000${i}`));
      await writer.flush();
    }
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(await readdir(dir)).toHaveLength(4);
  });

  it.each(["write after a minute", "explicit prune", "configuration change"])(
    "detects external growth during %s", async reason => {
      const dir = await makeCaptureDir();
      const writer = DebugCaptureWriter.fromConfig(dir, 1024, 10_000);
      await writer.flush();
      const external = path.join(dir, existingName);
      await writeFile(external, Buffer.alloc(20_000));
      if (reason === "write after a minute") {
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
        try {
          await writer.write(captureRecord("00000000-0000-0000-0000-000000000001"));
          await writer.flush();
        } finally {
          clock.mockRestore();
        }
      } else if (reason === "explicit prune") {
        await writer.pruneOldCaptures();
      } else {
        writer.configure(dir, 1024, 11_000);
        await writer.flush();
      }
      expect(existsSync(external)).toBe(false);
    }
  );

  it("enforces the cap immediately when the writer fills the remaining space", async () => {
    const dir = await makeCaptureDir();
    const external = path.join(dir, existingName);
    await writeFile(external, Buffer.alloc(99_500));
    const writer = DebugCaptureWriter.fromConfig(dir, 1024, 100_000);
    await writer.flush();
    const written = await writer.write(captureRecord("00000000-0000-0000-0000-000000000001"));
    await writer.flush();
    expect(existsSync(external)).toBe(false);
    expect(existsSync(written!)).toBe(true);
  });

  it("counts concurrent writes absent from a directory scan before deciding the cap is satisfied", async () => {
    const dir = await makeCaptureDir();
    const external = path.join(dir, existingName);
    await writeFile(external, Buffer.alloc(20_000));
    const writer = DebugCaptureWriter.fromConfig(dir, 1024, 100_000);
    await writer.flush();
    await writeFile(external, Buffer.alloc(99_500));
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let scanned!: () => void, release!: () => void;
    const listed = new Promise<void>(resolve => { scanned = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(stat).mockImplementationOnce(async (...args) => {
      scanned();
      await hold;
      return fs.stat(...args);
    });
    const scan = writer.pruneOldCaptures();
    try {
      await listed;
      await writer.write(captureRecord("00000000-0000-0000-0000-000000000001"));
    } finally {
      release();
      await scan;
    }
    expect(existsSync(external)).toBe(false);
    expect(await readdir(dir)).toHaveLength(1);
  });

  describe.each(["scan", "delete"] as const)("configuration changes during %s", stage => {
    it.each([
      [100_000, false], [10_000, false], [100_000, true], [10_000, true]
    ] as const)("uses the directory's latest cap %i, switches directory=%s", async (latestCap, switchDirectory) => {
      const dir = await makeCaptureDir();
      const otherDir = await makeCaptureDir();
      const purged = vi.fn();
      const writer = DebugCaptureWriter.fromConfig(dir, 1024, 100_000, purged);
      await writer.flush();
      const files = Array.from({ length: 3 }, (_, index) => path.join(dir,
        `compactgate-capture-000${index}-primary-v1-responses-00000000-0000-0000-0000-00000000000${index}.json`));
      for (const file of files) await writeFile(file, Buffer.alloc(20_000));
      const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let entered!: () => void, release!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      let deletedPath: string | undefined;
      if (stage === "scan") {
        vi.mocked(stat).mockImplementationOnce(async (...args) => {
          entered();
          await hold;
          return fs.stat(...args);
        });
      } else {
        vi.mocked(unlink).mockImplementationOnce(async (...args) => {
          await fs.unlink(...args);
          deletedPath = String(args[0]);
          entered();
          await hold;
        });
      }
      try {
        writer.configure(dir, 1024, 10_000);
        await paused;
        writer.configure(dir, 1024, latestCap);
        if (switchDirectory) writer.configure(otherDir, 1024, latestCap === 100_000 ? 1 : 100_000);
      } finally {
        release();
        await writer.flush();
      }
      const retained = latestCap === 100_000 ? files.filter(file => file !== deletedPath) : [];
      expect((await readdir(dir)).sort()).toEqual(retained.map(file => path.basename(file)).sort());
      const removed = files.filter(file => !retained.includes(file));
      expect(purged).toHaveBeenCalledTimes(removed.length > 0 ? 1 : 0);
      if (removed.length > 0) expect(purged).toHaveBeenCalledWith(expect.arrayContaining(removed));
    });
  });

  it("bounds the generated filename for long request paths", async () => {
    const dir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir);
    const record = captureRecord("00000000-0000-0000-0000-000000000007");
    record.path = `/v1/${"very-long-segment/".repeat(40)}`;

    const capturePath = await writer.write(record);

    expect(capturePath).not.toBeNull();
    expect(path.basename(capturePath ?? "").length).toBeLessThanOrEqual(240);
    expect(existsSync(capturePath ?? "")).toBe(true);
  });

  it("does not delete unrelated JSON files from the capture directory", async () => {
    const dir = await makeCaptureDir();
    const unrelatedPath = path.join(dir, "important-user-data.json");
    await writeFile(unrelatedPath, "x".repeat(200));
    const writer = DebugCaptureWriter.fromConfig(dir, 1024, 1);

    const capturePath = await writer.write(captureRecord("00000000-0000-0000-0000-000000000001"));
    await writer.pruneOldCaptures();

    expect(existsSync(unrelatedPath)).toBe(true);
    expect(capturePath).not.toBeNull();
    expect(existsSync(capturePath ?? "")).toBe(false);
  });

  it("coalesces concurrent pruning without deleting below the configured cap", async () => {
    const dir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir, 1024, 50);

    for (let index = 0; index < 10; index += 1) {
      const requestId = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
      const filename = `compactgate-capture-${String(index).padStart(4, "0")}-primary-v1-responses-${requestId}.json`;
      await writeFile(path.join(dir, filename), "0123456789");
    }

    await Promise.all(Array.from({ length: 8 }, () => writer.pruneOldCaptures()));

    const remaining = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    expect(remaining).toHaveLength(5);
  });

  it("registers a capture before pruning can report it as purged", async () => {
    const dir = await makeCaptureDir();
    const events: string[] = [];
    const writer = DebugCaptureWriter.fromConfig(
      dir,
      1024,
      1,
      (capturePath) => {
        events.push(`purged:${capturePath}`);
      }
    );

    const capturePath = await writer.write(
      captureRecord("00000000-0000-0000-0000-000000000001"),
      (writtenPath) => {
        events.push(`written:${writtenPath}`);
      }
    );
    await writer.pruneOldCaptures();

    expect(capturePath).not.toBeNull();
    expect(events).toEqual([
      `written:${capturePath}`,
      `purged:${capturePath}`
    ]);
  });

  it("keeps the newest directory cap when a write overlaps hot configuration", async () => {
    const dir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir, 1024 * 1024, 10 * 1024 * 1024);
    const record = captureRecord("00000000-0000-0000-0000-000000000008");
    record.incoming_request.body.text = "x".repeat(600_000);

    const writePromise = writer.write(record);
    writer.configure(dir, 1024 * 1024, 1);
    const capturePath = await writePromise;

    expect(capturePath).not.toBeNull();
    await waitFor(() => !existsSync(capturePath ?? ""));
  });

  it("keeps a directory's newest cap after capture switches elsewhere", async () => {
    const firstDir = await makeCaptureDir();
    const secondDir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(firstDir, 1024 * 1024, 10 * 1024 * 1024);
    const record = captureRecord("00000000-0000-0000-0000-000000000009");
    record.incoming_request.body.text = "x".repeat(600_000);

    const writePromise = writer.write(record);
    writer.configure(firstDir, 1024 * 1024, 1);
    writer.configure(secondDir, 1024 * 1024, 10 * 1024 * 1024);
    const capturePath = await writePromise;

    expect(capturePath).not.toBeNull();
    await waitFor(() => !existsSync(capturePath ?? ""));
  });
});

describe("DebugCaptureWriter header redaction", () => {
  it("redacts Cookie response and request headers", () => {
    expect(serializeHeaders({
      cookie: "session=request-secret",
      "set-cookie": ["session=response-secret", "refresh=other-secret"],
      "content-type": "application/json"
    })).toEqual({
      cookie: "[redacted]",
      "set-cookie": "[redacted]",
      "content-type": "application/json"
    });
  });

  it("redacts configured extra header names", () => {
    expect(serializeHeaders({
      "x-tenant-secret": "configured-secret",
      "x-visible": "plain"
    }, ["X-Tenant-Secret"])).toEqual({
      "x-tenant-secret": "[redacted]",
      "x-visible": "plain"
    });
  });
});

describe("DebugCaptureWriter safe reads", () => {
  it("can read a raw download without deriving display text", async () => {
    const dir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir);
    const requestId = "00000000-0000-0000-0000-000000000010";
    const record = captureRecord(requestId);
    record.incoming_request.body = writer.serializeBody(Buffer.from("raw capture"));
    const capturePath = await writer.write(record);
    const raw = await writer.readCapture(capturePath!, requestId, false);
    expect(raw.status).toBe("found");
    if (raw.status !== "found") throw new Error("Synthetic capture is missing");
    expect(raw.record).toEqual(record);
    expect(raw.content.toString("utf8")).toBe(`${JSON.stringify(record, null, 2)}\n`);
    await expect(writer.readCapture(capturePath!, requestId)).resolves.toMatchObject({
      status: "found", record: { incoming_request: { body: { text: "raw capture" } } }
    });
  });

  it("reads only managed regular captures with a matching request ID", async () => {
    const dir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir);
    const requestId = "00000000-0000-0000-0000-000000000001";
    const capturePath = await writer.write(captureRecord(requestId));

    expect(capturePath).not.toBeNull();
    await expect(writer.readCapture(capturePath ?? "", requestId)).resolves.toMatchObject({
      status: "found",
      record: {
        request_id: requestId
      }
    });
    await expect(
      writer.readCapture(capturePath ?? "", "00000000-0000-0000-0000-000000000002")
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      writer.readCapture(path.join(dir, "important-user-data.json"), requestId)
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("keeps registered historical captures readable after capture is disabled", async () => {
    const dir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir);
    const requestId = "00000000-0000-0000-0000-000000000005";
    const capturePath = await writer.write(captureRecord(requestId));
    writer.configure(null);

    await expect(writer.readCapture(capturePath ?? "", requestId)).resolves.toMatchObject({
      status: "found",
      record: {
        request_id: requestId
      }
    });
  });

  it("rejects symbolic links while allowing registered captures from an older directory", async () => {
    const dir = await makeCaptureDir();
    const outsideDir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir);
    const requestId = "00000000-0000-0000-0000-000000000003";
    const filename = `compactgate-capture-0001-primary-v1-responses-${requestId}.json`;
    const outsidePath = path.join(outsideDir, filename);
    const symlinkPath = path.join(dir, filename);
    await writeFile(outsidePath, JSON.stringify(captureRecord(requestId)));
    await symlink(outsidePath, symlinkPath);

    await expect(writer.readCapture(symlinkPath, requestId)).resolves.toEqual({
      status: "unavailable"
    });
    await expect(writer.readCapture(outsidePath, requestId)).resolves.toMatchObject({
      status: "found",
      record: {
        request_id: requestId
      }
    });
  });

  it("rejects malformed managed JSON instead of returning partial capture records", async () => {
    const dir = await makeCaptureDir();
    const writer = DebugCaptureWriter.fromConfig(dir);
    const requestId = "00000000-0000-0000-0000-000000000006";
    const capturePath = path.join(
      dir,
      `compactgate-capture-0001-primary-v1-responses-${requestId}.json`
    );
    await writeFile(capturePath, `{"request_id": "${requestId}"`);

    await expect(writer.readCapture(capturePath, requestId)).rejects.toBeInstanceOf(SyntaxError);
  });

  it("distinguishes a missing capture from unreadable or unsafe captures", async () => {
    const dir = await makeCaptureDir();
    const requestId = "00000000-0000-0000-0000-000000000008";
    const capturePath = path.join(dir, `compactgate-capture-0001-primary-v1-responses-${requestId}.json`);
    await expect(DebugCaptureWriter.fromConfig(dir).readCapture(capturePath, requestId))
      .resolves.toEqual({ status: "missing" });
  });
});

async function makeCaptureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-prune-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for capture state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captureRecord(requestId: string): CaptureRecord {
  const body = {
    byte_length: 0,
    captured_byte_length: 0,
    truncated: false,
    text: "",
    base64: ""
  };
  return {
    request_id: requestId,
    time: "2026-07-15T00:00:00.000Z",
    completed_at: "2026-07-15T00:00:01.000Z",
    route: "primary",
    method: "POST",
    path: "/v1/responses",
    upstream_url: "https://upstream.example/v1/responses",
    upstream_host: "upstream.example",
    source_model: "gpt-test",
    target_model: "gpt-test",
    compact_bridge_replacements: 0,
    compact_response_normalized: false,
    compact_response_normalize_reason: null,
    compact_response_synthetic_source: null,
    incoming_request: { headers: {}, body },
    upstream_request: { headers: {}, body },
    upstream_response: { headers: {}, status: 200, body },
    client_response: null
  };
}
