import { describe, expect, it } from "vitest";
import { captureRequest, startApp, startUpstream, postJson, writeJsonResponse, waitForLogEntry } from "./helpers/server-test-utils.js";

const requestBody = { model: "synthetic-model", store: false, input: [
  { type: "reasoning", encrypted_content: "rejected-state", summary: [] },
  { type: "message", role: "user", content: "Summarize the visible context." }
] };
const rejection = { type: "invalid_request_error", code: "invalid_encrypted_content", param: "input[0].encrypted_content" };

describe("provider state recovery across Responses entrypoints", () => {
  for (const mode of ["primary", "local", "remote_v1"] as const) {
    it.each(["http", "sse", "off"])(`${mode} recovery via %s`, async transport => {
      const seen: Array<{ input: unknown[] }> = [];
      const upstream = await startUpstream(async (req, res) => {
        const body = JSON.parse((await captureRequest(req)).body);
        seen.push(body);
        if (body.input.some((item: { type: string }) => item.type === "reasoning")) {
          if (transport === "sse") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: rejection } })}\n\n`);
          } else writeJsonResponse(res, { error: rejection }, 400);
          return;
        }
        writeJsonResponse(res, { status: "completed", output: mode === "remote_v1"
          ? [{ type: "compaction", encrypted_content: "synthetic-new-state" }]
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "synthetic result" }] }]
        });
      });
      const app = await startApp(upstream.url, upstream.url, { compact: { model_template: "{model}" },
        primary_failover: { state_portability: transport === "off" ? "off" : "recover_on_error", state_recovery_retention_hours: 0 }
      });
      const path = mode === "remote_v1" ? "/v1/responses/compact" : "/v1/responses";
      const headers: Record<string, string> = mode === "local" ? { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) } : {};
      const response = await postJson(app.url, path, requestBody, headers);
      await response.text();
      expect(response.status).toBe(transport === "off" ? 400 : 200);
      expect(seen).toHaveLength(transport === "off" ? 1 : 2);
      if (transport === "off") return;
      expect(seen[1].input).toEqual([seen[0].input[1]]);
      expect(response.headers.get("x-compactgate-state-recovery")).toBe("recovered");
      expect(response.headers.get("x-compactgate-context-fidelity")).toBe("degraded");
      const log = await waitForLogEntry(app.url, entry => entry.provider_state_portability?.trigger === "explicit_400");
      expect(log.provider_state_portability?.attempts).toHaveLength(2);
      if (mode === "remote_v1") {
        const repeated = await postJson(app.url, path, requestBody, headers);
        await repeated.text();
        expect(repeated.status).toBe(200);
        expect(repeated.headers.get("x-compactgate-context-fidelity")).toBe("degraded");
        expect(seen).toHaveLength(4);
      }
    });
  }

  it.each(["local", "remote_v1"])("shares the three status retries across %s recovery attempts", async mode => {
    let attempts = 0;
    const upstream = await startUpstream(async (req, res) => {
      await captureRequest(req);
      attempts++;
      res.setHeader("retry-after", "0");
      writeJsonResponse(res, { error: attempts === 3 ? rejection : { message: "temporary" } }, attempts === 3 ? 400 : 503);
    });
    const app = await startApp(upstream.url, upstream.url);
    const response = await postJson(app.url, mode === "remote_v1" ? "/v1/responses/compact" : "/v1/responses", requestBody,
      mode === "local" ? { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }) } : {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { message: "temporary" } });
    expect(attempts).toBe(5);
  });
});
