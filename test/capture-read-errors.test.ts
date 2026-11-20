import { mkdtemp, open, readFile, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DebugCaptureWriter } from "../src/server/debug-capture.js";
import {
  captureBody, cleanup, startApp, startUpstream, waitForCaptureRecords
} from "./helpers/server-test-utils.js";

async function capturedRequest() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-capture-errors-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const upstream = await startUpstream(async (req, res) => {
    await captureBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const app = await startApp(upstream.url, upstream.url, { logging: { capture_dir: dir } });
  const response = await fetch(`${app.url}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "synthetic", input: "fixture" })
  });
  await response.text();
  await waitForCaptureRecords(dir, 1);
  const requestId = response.headers.get("x-compactgate-request-id")!;
  const filename = (await readdir(dir)).find(file => file.endsWith(".json"))!;
  return { url: `${app.url}/api/logs/${requestId}/capture`, path: path.join(dir, filename), requestId };
}

describe("capture read failure lifecycle", () => {
  it.each(["", "/download"])("cancels the pending file read on disconnect: %s", async suffix => {
    const fixture = await capturedRequest();
    const handle = await open(fixture.path);
    const handlePrototype: FileHandle = Object.getPrototypeOf(handle);
    await handle.close();
    let finishRead!: () => void;
    const held = new Promise<void>(resolve => { finishRead = resolve; });
    const fileRead = vi.spyOn(handlePrototype, "readFile").mockImplementationOnce(async () => {
      await held;
      // A read can complete as the socket closes. Its bytes must never reach JSON.parse.
      return Buffer.from("{");
    });
    const captureRead = vi.spyOn(DebugCaptureWriter.prototype, "readCapture");
    const diagnostic = vi.spyOn(console, "error");
    const client = new AbortController();
    const response = fetch(fixture.url + suffix, { signal: client.signal }).catch(error => error);
    try {
      await vi.waitFor(() => expect(fileRead).toHaveBeenCalledOnce());
      const options = fileRead.mock.calls[0][0];
      const signal = typeof options === "object" ? options?.signal : undefined;
      client.abort();
      expect(await response).toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      finishRead();
      await expect(captureRead.mock.results[0].value).rejects.toMatchObject({ name: "AbortError" });
      expect(diagnostic).not.toHaveBeenCalled();
      expect((await fetch(fixture.url + suffix)).status).toBe(200);
    } finally {
      client.abort();
      finishRead();
      fileRead.mockRestore();
      captureRead.mockRestore();
      diagnostic.mockRestore();
    }
  });

  it.each(["", "/download"])("retains a malformed file for repair: %s", async suffix => {
    const fixture = await capturedRequest();
    const original = await readFile(fixture.path);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(fixture.path, "{");
      const failed = await fetch(fixture.url + suffix);
      expect(failed.status).toBe(500);
      const error = await failed.json();
      expect(error).toMatchObject({ request_id: fixture.requestId, capture_status: "present" });
      expect(JSON.stringify(error)).not.toContain(fixture.path);
      expect(diagnostic).toHaveBeenCalled();
      await writeFile(fixture.path, original);
      const restored = await fetch(fixture.url + suffix);
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ request_id: fixture.requestId });
    } finally {
      await writeFile(fixture.path, original);
      diagnostic.mockRestore();
    }
  });

  it("retains registered captures after transient I/O failure", async () => {
    const fixture = await capturedRequest();
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const reader = vi.spyOn(DebugCaptureWriter.prototype, "readCapture")
      .mockRejectedValueOnce(Object.assign(new Error("Synthetic read failure"), { code: "EIO" }));
    try {
      expect((await fetch(fixture.url)).status).toBe(500);
      expect((await fetch(fixture.url)).status).toBe(200);
    } finally {
      reader.mockRestore();
      diagnostic.mockRestore();
    }
  });
});
