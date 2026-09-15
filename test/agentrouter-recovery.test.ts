import http, { type IncomingMessage, type RequestOptions } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureRequest, postJson, startApp, startUpstream, waitForLogEntry, writeJsonResponse,
  type CapturedRequest
} from "./helpers/server-test-utils.js";

// Only the socket destination is replaced. Routing, host quirks, HTTP/SSE,
// headers, migration, and logging all run normally, with no external traffic.
const realRequest = http.request;
beforeEach(() => {
  vi.spyOn(http, "request").mockImplementation(((url: URL, options: RequestOptions,
    callback: (response: IncomingMessage) => void) => {
    if (!(url instanceof URL) || url.protocol !== "http:" || !url.port) {
      throw new Error("Test transport only permits the loopback HTTP fixture.");
    }
    const localUrl = new URL(url);
    localUrl.hostname = "127.0.0.1";
    return realRequest(localUrl, { ...options, headers: { ...options.headers, host: url.host } }, callback);
  }) as typeof http.request);
});
afterEach(() => vi.restoreAllMocks());

const azureError = { error: {
  message: "The requested item was created under a different Azure OpenAI resource. " +
    "Use the same resource that created the item to access it.\n[trace_id=15d282710125406b3b990feef345de65]",
  type: "invalid_request_error", param: "", code: null
} };
const compaction = { type: "compaction", id: "cmp_synthetic", encrypted_content: "opaque-synthetic-state" };
const requestBody = (stream = false) => ({
  model: "synthetic-model", store: false, stream,
  input: [
    { type: "message", id: "msg_synthetic", role: "assistant", content: [] },
    compaction,
    { type: "message", role: "user", content: "continue" }
  ]
});
const betaHeaders = { "x-codex-beta-features": "remote_compaction_v2" };

describe("agentrouter recovery through the HTTP proxy", () => {
  it.each([false, true])("preserves context and the selected upstream before a successful stream=%s retry", async (stream) => {
    const sent: CapturedRequest[] = [];
    const responseBody = { id: "resp_synthetic", object: "response", model: "synthetic-model", status: "completed", output: [] };
    const upstream = await startUpstream(async (req, res) => {
      sent.push(await captureRequest(req));
      if (sent.length === 1) {
        res.writeHead(400, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(JSON.stringify(azureError)));
      } else if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: responseBody })}\n\n`);
      } else {
        writeJsonResponse(res, responseBody);
      }
    });
    const app = await startApp(upstream.url.replace("127.0.0.1", "agentrouter.org"), undefined, {
      primary: { api_key: "synthetic-key" }
    });
    const response = await postJson(app.url, "/v1/responses", requestBody(stream), betaHeaders);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("resp_synthetic");
    expect(text).not.toContain("different Azure OpenAI resource");
    expect(sent).toHaveLength(2);
    const first = JSON.parse(sent[0].body);
    const second = JSON.parse(sent[1].body);
    expect(first.input[0].id).toBeUndefined(); // existing first-send quirk
    expect(first.input[1]).toEqual(compaction);
    delete first.input[1].id;
    expect(second).toEqual(first);
    for (const request of sent) {
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe("Bearer synthetic-key");
      expect(request.headers["x-codex-beta-features"]).toBe("remote_compaction_v2");
      expect(Number(request.headers["content-length"])).toBe(Buffer.byteLength(request.body));
    }
    expect(sent[0].headers.host).toBe(sent[1].headers.host);
    const log = await waitForLogEntry(app.url, (entry) => entry.request_id === response.headers.get("x-compactgate-request-id"));
    expect(log.status).toBe(200);
    expect(log.stream_outcome).toBe("success");
    expect(log.provider_state_portability).toMatchObject({
      decision: "recovery", trigger: "explicit_400", target_state_free_success: false,
      attempts: [
        { strategy: "original", status: 400, error_code: null },
        { strategy: "error_400", status: 200, fidelity: "exact", migration_counts: {
          providerItemIdsRemoved: 1, compactionItemsRemoved: 0, encryptedReasoningFieldsRemoved: 0
        } }
      ]
    });
  });

  it("returns the second real error with no third send or broader cleanup", async () => {
    const sent: CapturedRequest[] = [];
    const secondError = { error: { code: "invalid_encrypted_content", message: "synthetic second failure" } };
    const upstream = await startUpstream(async (req, res) => {
      sent.push(await captureRequest(req));
      writeJsonResponse(res, sent.length === 1 ? azureError : secondError, 400);
    });
    const app = await startApp(upstream.url.replace("127.0.0.1", "agentrouter.org"));
    const response = await postJson(app.url, "/v1/responses", requestBody(true), betaHeaders);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(secondError);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1].body).input[1]).toEqual({ type: "compaction", encrypted_content: compaction.encrypted_content });
  });

  it.each(["other-host", "disabled", "success"])("keeps existing behavior for %s", async (scenario) => {
    const sent: CapturedRequest[] = [];
    const upstream = await startUpstream(async (req, res) => {
      sent.push(await captureRequest(req));
      writeJsonResponse(res, scenario === "success" ? { output: [] } : azureError, scenario === "success" ? 200 : 400);
    });
    const app = await startApp(upstream.url.replace("127.0.0.1", scenario === "other-host" ? "other.example" : "agentrouter.org"), undefined, {
      primary_failover: { state_portability: scenario === "disabled" ? "off" : "recover_on_error" }
    });
    const response = await postJson(app.url, "/v1/responses", requestBody(), betaHeaders);
    expect(response.status).toBe(scenario === "success" ? 200 : 400);
    await response.text();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body).input[1]).toEqual(compaction);
  });
});
