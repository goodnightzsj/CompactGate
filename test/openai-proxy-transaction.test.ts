import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebugCaptureWriter } from "../src/server/debug-capture.js";
import { RequestLogger } from "../src/server/logger.js";
import { finalizeOpenAiProxyTransaction } from "../src/server/openai-proxy-transaction.js";
import { StudioEventBroadcaster } from "../src/server/studio-events.js";
import { emptyUsageMetrics } from "../src/server/proxy-support.js";
import { CodexVersionMonitor } from "../src/server/codex-version.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const clean = cleanup.pop();
    if (clean) {
      await clean();
    }
  }
});

describe("finalizeOpenAiProxyTransaction", () => {
  it("attaches the current protocol status to compact log inserts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-finalize-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const logger = new RequestLogger(10, path.join(dir, "logs.sqlite"));
    const studioEvents = new StudioEventBroadcaster();
    const monitor = new CodexVersionMonitor({ probe: () => null });
    const broadcastSpy = vi.spyOn(studioEvents, "broadcastLog");
    const captureWriter = { isEnabled: () => false } as unknown as DebugCaptureWriter;

    try {
      await finalizeOpenAiProxyTransaction({
        logger,
        captureWriter,
        studioEvents,
        codexVersionMonitor: monitor,
        route: "compact",
        compactionMode: "remote_v2",
        compactionDetectionSource: "input",
        req: {
          method: "POST",
          headers: { "user-agent": "codex-tui/0.144.1-cometix" }
        } as IncomingMessage,
        url: new URL("http://compactgate.local/v1/responses"),
        status: 200,
        upstreamStatus: 200,
        streamTerminalEvent: "response.completed",
        streamOutcome: "success",
        startedAt: performance.now(),
        startedAtIso: "2026-07-15T00:00:00.000Z",
        requestMetadata: null,
        requestType: "stream",
        upstream: new URL("https://upstream.example/v1/responses"),
        requestId: "compact-status-event",
        sourceModel: "gpt-5.6-sol",
        targetModel: "gpt-5.6-sol",
        firstTokenMs: 10,
        usage: emptyUsageMetrics(),
        errorSummary: null,
        compactBridgeReplacements: 0,
        rawBody: Buffer.from("{}"),
        requestHeaders: {},
        upstreamBody: Buffer.from("{}"),
        responseBody: Buffer.from(`event: response.completed\ndata: {"type":"response.completed"}\n\n`),
        responseHeaders: {},
        clientResponseBody: null,
        clientResponseHeaders: null,
        persistBody: false,
        compactResponseNormalized: false,
        compactResponseNormalizeReason: null,
        compactResponseSyntheticSource: null
      });

      expect(broadcastSpy.mock.calls[0]?.[2]).toMatchObject({
        observed_protocol: "remote_v2",
        protocol_source: "request",
        observed_clients: [{ raw_version: "0.144.1-cometix", protocols: ["remote_v2"] }]
      });
    } finally {
      logger.close();
      studioEvents.close();
      monitor.close();
    }
  });

  it("persists the request log before waiting for capture IO", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-finalize-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const logger = new RequestLogger(10, path.join(dir, "logs.sqlite"));
    const studioEvents = new StudioEventBroadcaster();
    const broadcastSpy = vi.spyOn(studioEvents, "broadcastLog");
    let finishCapture: (capturePath: string | null) => void = () => {
      throw new Error("Expected capture write to be pending.");
    };
    const captureWriter = {
      isEnabled: () => true,
      serializeBody: (buffer: Buffer) => ({
        byte_length: buffer.byteLength,
        captured_byte_length: buffer.byteLength,
        truncated: false,
        text: buffer.toString("utf8"),
        base64: buffer.toString("base64")
      }),
      write: () =>
        new Promise<string | null>((resolve) => {
          finishCapture = resolve;
        })
    } as unknown as DebugCaptureWriter;

    try {
      const finalizePromise = finalizeOpenAiProxyTransaction({
        logger,
        captureWriter,
        studioEvents,
        route: "primary",
        req: { method: "POST", headers: {} } as IncomingMessage,
        url: new URL("http://compactgate.local/v1/responses"),
        status: 200,
        startedAt: performance.now(),
        startedAtIso: "2026-07-15T00:00:00.000Z",
        requestMetadata: null,
        requestType: "http",
        upstream: new URL("https://upstream.example/v1/responses"),
        requestId: "request-visible-before-capture",
        sourceModel: "gpt-test",
        targetModel: "gpt-test",
        firstTokenMs: null,
        usage: emptyUsageMetrics(),
        errorSummary: null,
        compactBridgeReplacements: 0,
        rawBody: Buffer.from("{}"),
        requestHeaders: {},
        upstreamBody: Buffer.from("{}"),
        responseBody: Buffer.from("{}"),
        responseHeaders: {},
        clientResponseBody: null,
        clientResponseHeaders: null,
        persistBody: false,
        compactResponseNormalized: false,
        compactResponseNormalizeReason: null,
        compactResponseSyntheticSource: null
      });

      expect(logger.getByRequestId("request-visible-before-capture").status).toBe("found");

      finishCapture(path.join(dir, "capture.json"));
      await finalizePromise;

      const result = logger.getByRequestId("request-visible-before-capture");
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.entry.capture_path).toBeNull();
        expect(result.entry.capture_status).toBe("present");
      }
      expect(logger.getCaptureByRequestId("request-visible-before-capture")).toMatchObject({
        status: "found",
        capturePath: path.join(dir, "capture.json"),
        captureStatus: "present"
      });
      expect(
        broadcastSpy.mock.calls.map((call) => (call as unknown as unknown[])[1])
      ).toEqual(["insert", "update"]);
    } finally {
      logger.close();
      studioEvents.close();
    }
  });

  it("does not overwrite a capture purged during persistence with present", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "compactgate-finalize-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const logger = new RequestLogger(10, path.join(dir, "logs.sqlite"));
    const studioEvents = new StudioEventBroadcaster();
    const capturePath = path.join(dir, "capture.json");
    const captureWriter = {
      isEnabled: () => true,
      serializeBody: (buffer: Buffer) => ({
        byte_length: buffer.byteLength,
        captured_byte_length: buffer.byteLength,
        truncated: false,
        text: buffer.toString("utf8"),
        base64: buffer.toString("base64")
      }),
      write: async (
        _record: unknown,
        onWritten?: (writtenPath: string) => void
      ): Promise<string | null> => {
        onWritten?.(capturePath);
        logger.markCapturePurged(capturePath);
        return capturePath;
      }
    } as unknown as DebugCaptureWriter;

    try {
      await finalizeOpenAiProxyTransaction({
        logger,
        captureWriter,
        studioEvents,
        route: "primary",
        req: { method: "POST", headers: {} } as IncomingMessage,
        url: new URL("http://compactgate.local/v1/responses"),
        status: 200,
        startedAt: performance.now(),
        startedAtIso: "2026-07-15T00:00:00.000Z",
        requestMetadata: null,
        requestType: "http",
        upstream: new URL("https://upstream.example/v1/responses"),
        requestId: "request-purged-during-capture",
        sourceModel: "gpt-test",
        targetModel: "gpt-test",
        firstTokenMs: null,
        usage: emptyUsageMetrics(),
        errorSummary: null,
        compactBridgeReplacements: 0,
        rawBody: Buffer.from("{}"),
        requestHeaders: {},
        upstreamBody: Buffer.from("{}"),
        responseBody: Buffer.from("{}"),
        responseHeaders: {},
        clientResponseBody: null,
        clientResponseHeaders: null,
        persistBody: false,
        compactResponseNormalized: false,
        compactResponseNormalizeReason: null,
        compactResponseSyntheticSource: null
      });

      const result = logger.getByRequestId("request-purged-during-capture");
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.entry.capture_path).toBeNull();
        expect(result.entry.capture_status).toBe("purged");
      }
      expect(logger.getCaptureByRequestId("request-purged-during-capture")).toMatchObject({
        status: "found",
        capturePath: null,
        captureStatus: "purged"
      });
    } finally {
      logger.close();
      studioEvents.close();
    }
  });
});
