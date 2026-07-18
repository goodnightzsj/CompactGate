import { describe, expect, it } from "vitest";
import {
  assertCaptured,
  captureBody,
  type CapturedRequest,
  startApp,
  startUpstream
} from "./helpers/server-test-utils.js";
import {
  JSON_HEADERS,
  startCapturedOpenAiUpstream,
  writeJson
} from "./server-openai-failover-helpers.js";

describe("CompactGate OpenAI routing", () => {
  it("routes compact requests to primary when upstream mode is primary", async () => {
    const captured: { current: CapturedRequest | null } = { current: null };
    const primary = await startUpstream(async (req, res) => {
      captured.current = {
        method: req.method ?? "POST",
        url: req.url ?? "",
        headers: req.headers,
        body: await captureBody(req)
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const compact = await startUpstream((_req, res) => res.end("{}"));
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "primary" }
    });

    const response = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true }),
      headers: JSON_HEADERS
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-compactgate-route")).toBe("compact");
    assertCaptured(captured.current);
    expect(captured.current.url).toBe("/v1/responses/compact");
    expect(JSON.parse(captured.current.body)).toEqual({
      model: "gpt-5.5-openai-compact",
      stream: true
    });

    const logsResponse = await fetch(`${app.url}/api/logs/recent`);
    const logsBody = await logsResponse.json();
    expect(logsBody.logs[0]).toMatchObject({
      route: "compact",
      upstream_host: new URL(primary.url).host,
      source_model: "gpt-5.5",
      target_model: "gpt-5.5-openai-compact"
    });
  });

  it("keeps primary-mode compact follow-ups on primary without bridge rewrite", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (res) => writeJson(res, {
      object: "response.compaction",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "PRIMARY COMPACT SUMMARY" }]
        },
        {
          type: "compaction",
          encrypted_content: "PRIMARY_MODE_COMPACT_STATE"
        }
      ]
    }));
    const compact = await startCapturedOpenAiUpstream(compactRequests, (res) => {
      res.end("{}");
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "primary" }
    });

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "primary compact" }),
      headers: JSON_HEADERS
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    const followUpBody = JSON.stringify({
      model: "gpt-5.5",
      input: [
        {
          type: "compaction",
          encrypted_content: "PRIMARY_MODE_COMPACT_STATE"
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "after primary compact" }]
        }
      ]
    });
    const followUpResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: followUpBody,
      headers: JSON_HEADERS
    });

    expect(followUpResponse.status).toBe(200);
    expect(followUpResponse.headers.get("x-compactgate-route")).toBe("primary");
    await followUpResponse.text();
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests).toHaveLength(2);
    expect(primaryRequests[1].url).toBe("/v1/responses");
    expect(JSON.parse(primaryRequests[1].body)).toEqual(JSON.parse(followUpBody));
  });

  it("rewrites locally normalized primary-mode compact follow-ups before primary", async () => {
    const summaryText = [
      "- Primary-mode local compact summary.",
      "- The compact response was synthesized by CompactGate.",
      "- The follow-up must reach primary as an assistant message."
    ].join("\n");
    const primaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const primary = await startCapturedOpenAiUpstream(primaryRequests, (res) => {
      if (primaryRequests.length === 1) {
        writeJson(res, {
          id: "resp_primary_mode_normalized",
          object: "response",
          output_text: summaryText
        });
        return;
      }

      writeJson(res, { ok: true });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (res) => {
      writeJson(res, { should_not_be_called: true });
    });
    const app = await startApp(primary.url, compact.url, {
      compact: { upstream_mode: "primary" }
    });

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "primary synthetic compact" }),
      headers: JSON_HEADERS
    });
    expect(compactResponse.status).toBe(200);
    // 方案 B:客户端收原始上游 JSON,归一化仅用于桥接存储。
    const compactBody = await compactResponse.json() as { output_text?: string };
    expect(compactBody.output_text).toBe(summaryText);

    const followUpResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.5",
        input: [
          {
            type: "compaction",
            encrypted_content: summaryText
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "after primary synthetic compact" }]
          }
        ]
      }),
      headers: JSON_HEADERS
    });

    expect(followUpResponse.status).toBe(200);
    await followUpResponse.text();
    expect(compactRequests).toHaveLength(0);
    expect(primaryRequests).toHaveLength(2);
    expect(JSON.parse(primaryRequests[1].body).input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summaryText }]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after primary synthetic compact" }]
      }
    ]);
  });
});
