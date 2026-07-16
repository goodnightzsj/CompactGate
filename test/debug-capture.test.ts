import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CaptureRecord,
  DebugCaptureWriter,
  serializeHeaders
} from "../src/server/debug-capture.js";

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
});

describe("DebugCaptureWriter safe reads", () => {
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
    await writeFile(capturePath, JSON.stringify({ request_id: requestId }));

    await expect(writer.readCapture(capturePath, requestId)).resolves.toEqual({
      status: "unavailable"
    });
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
