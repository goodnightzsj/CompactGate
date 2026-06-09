import { describe, expect, it } from "vitest";
import {
  captureBody,
  type CapturedRequest,
  fetchRecentLogs,
  startApp,
  startUpstream
} from "./helpers/server-test-utils.js";
import {
  JSON_HEADERS,
  saveCodexProfile,
  startCapturedOpenAiUpstream,
  writeJson,
  writeSse
} from "./server-openai-failover-helpers.js";

describe("CompactGate OpenAI routing", () => {
  it("fails over Codex primary streams after four empty 200 responses without touching compact routing", async () => {
    const firstPrimaryRequests: CapturedRequest[] = [];
    const secondPrimaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const firstPrimary = await startCapturedOpenAiUpstream(firstPrimaryRequests, (res) => writeSse(res));
    const secondPrimary = await startCapturedOpenAiUpstream(secondPrimaryRequests, (res) => writeSse(res, [
      { type: "response.output_text.delta", delta: "second ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ]));
    const compact = await startCapturedOpenAiUpstream(compactRequests, (res) => writeJson(res, { ok: true }));
    const app = await startApp(firstPrimary.url, compact.url);

    const firstProfileId = await saveCodexProfile(app.url, compact.url, "primary-a", firstPrimary.url);
    const secondProfileId = await saveCodexProfile(app.url, compact.url, "primary-b", secondPrimary.url);
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyResponse.status).toBe(200);

    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${app.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", stream: true, input: `empty ${index}` }),
        headers: JSON_HEADERS
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    }

    const failoverResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "after failover" }),
      headers: JSON_HEADERS
    });
    expect(failoverResponse.status).toBe(200);
    expect(await failoverResponse.text()).toContain("second ok");

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "compact untouched" }),
      headers: JSON_HEADERS
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    expect(firstPrimaryRequests).toHaveLength(4);
    expect(secondPrimaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(1);
    expect(JSON.parse(secondPrimaryRequests[0].body)).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      input: "after failover"
    });
    expect(JSON.parse(compactRequests[0].body)).toMatchObject({
      model: "gpt-5.5-openai-compact",
      input: "compact untouched"
    });

    const logs = await fetchRecentLogs(app.url);
    expect(logs.filter((entry) => entry.upstream_host === new URL(firstPrimary.url).host)).toHaveLength(4);
    expect(logs.find((entry) => entry.error_summary === "OpenAI stream closed before response.completed.")).toMatchObject({
      route: "primary",
      status: 200,
      upstream_host: new URL(firstPrimary.url).host,
      error_summary: "OpenAI stream closed before response.completed."
    });
    expect(logs.find((entry) => entry.upstream_host === new URL(secondPrimary.url).host)).toMatchObject({
      route: "primary",
      status: 200,
      upstream_host: new URL(secondPrimary.url).host,
      error_summary: null
    });
    expect(logs.find((entry) => entry.upstream_host === new URL(compact.url).host)).toMatchObject({
      route: "compact",
      status: 200,
      upstream_host: new URL(compact.url).host,
      error_summary: null
    });
  });

  it("fails over Codex primary streams after four output-only 200 responses without completion", async () => {
    const firstPrimaryRequests: CapturedRequest[] = [];
    const secondPrimaryRequests: CapturedRequest[] = [];
    const firstPrimary = await startCapturedOpenAiUpstream(firstPrimaryRequests, (res) => writeSse(res, [
      { type: "response.output_text.delta", delta: "partial" }
    ]));
    const secondPrimary = await startCapturedOpenAiUpstream(secondPrimaryRequests, (res) => writeSse(res, [
      { type: "response.output_text.delta", delta: "second ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ]));
    const compact = await startUpstream((_req, res) => writeJson(res, { ok: true }));
    const app = await startApp(firstPrimary.url, compact.url);

    const firstProfileId = await saveCodexProfile(app.url, compact.url, "output-only-a", firstPrimary.url);
    const secondProfileId = await saveCodexProfile(app.url, compact.url, "output-only-b", secondPrimary.url);
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyResponse.status).toBe(200);

    for (let index = 0; index < 4; index += 1) {
      const response = await fetch(`${app.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", stream: true, input: `partial ${index}` }),
        headers: JSON_HEADERS
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("partial");
    }

    const failoverResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "after output-only failover" }),
      headers: JSON_HEADERS
    });
    expect(failoverResponse.status).toBe(200);
    expect(await failoverResponse.text()).toContain("second ok");

    expect(firstPrimaryRequests).toHaveLength(4);
    expect(secondPrimaryRequests).toHaveLength(1);

    const logs = await fetchRecentLogs(app.url);
    expect(logs.find((entry) => entry.upstream_host === new URL(firstPrimary.url).host)).toMatchObject({
      route: "primary",
      status: 200,
      upstream_host: new URL(firstPrimary.url).host,
      error_summary: "OpenAI stream closed before response.completed."
    });
    expect(logs.find((entry) => entry.upstream_host === new URL(secondPrimary.url).host)).toMatchObject({
      route: "primary",
      status: 200,
      upstream_host: new URL(secondPrimary.url).host,
      error_summary: null
    });
  });

  it("marks non-SSE 200 primary stream responses as incomplete", async () => {
    const primary = await startUpstream(async (req, res) => {
      await captureBody(req);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body>not an event stream</body></html>");
    });
    const compact = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const app = await startApp(primary.url, compact.url);

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "html instead of sse" }),
      headers: JSON_HEADERS
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("not an event stream");

    const [entry] = await fetchRecentLogs(app.url);
    expect(entry).toMatchObject({
      route: "primary",
      status: 200,
      upstream_host: new URL(primary.url).host,
      error_summary: "OpenAI stream response was not text/event-stream."
    });
  });

  it("avoids a Codex primary profile after an account-level failure without touching compact routing", async () => {
    const firstPrimaryRequests: CapturedRequest[] = [];
    const secondPrimaryRequests: CapturedRequest[] = [];
    const compactRequests: CapturedRequest[] = [];
    const firstPrimary = await startCapturedOpenAiUpstream(firstPrimaryRequests, (res) => {
      writeJson(res, { error: { message: "insufficient balance" } }, 403);
    });
    const secondPrimary = await startCapturedOpenAiUpstream(secondPrimaryRequests, (res) => {
      writeJson(res, { id: "resp-second", output: [{ content: "second ok" }] });
    });
    const compact = await startCapturedOpenAiUpstream(compactRequests, (res) => writeJson(res, { ok: true }));
    const app = await startApp(firstPrimary.url, compact.url);

    const firstProfileId = await saveCodexProfile(app.url, compact.url, "balance-a", firstPrimary.url);
    const secondProfileId = await saveCodexProfile(app.url, compact.url, "balance-b", secondPrimary.url);
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyResponse.status).toBe(200);

    const failingResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "first fails" }),
      headers: JSON_HEADERS
    });
    expect(failingResponse.status).toBe(403);
    await failingResponse.text();

    const recoveredResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "after account failure" }),
      headers: JSON_HEADERS
    });
    expect(recoveredResponse.status).toBe(200);
    expect(await recoveredResponse.text()).toContain("second ok");

    const compactResponse = await fetch(`${app.url}/v1/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "compact untouched" }),
      headers: JSON_HEADERS
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    expect(firstPrimaryRequests).toHaveLength(1);
    expect(secondPrimaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(1);
    expect(JSON.parse(secondPrimaryRequests[0].body)).toMatchObject({
      model: "gpt-5.5",
      input: "after account failure"
    });
    expect(JSON.parse(compactRequests[0].body)).toMatchObject({
      model: "gpt-5.5-openai-compact",
      input: "compact untouched"
    });
  });

  it("keeps opaque compaction state on the primary profile that successfully handled it", async () => {
    const firstPrimaryRequests: CapturedRequest[] = [];
    const secondPrimaryRequests: CapturedRequest[] = [];
    const firstPrimary = await startCapturedOpenAiUpstream(firstPrimaryRequests, (res) => {
      if (firstPrimaryRequests.length === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: { message: "rate limit" } }));
        return;
      }

      writeJson(res, {
        error: {
          message: "The encrypted content could not be decrypted or parsed."
        }
      }, 400);
    });
    const secondPrimary = await startCapturedOpenAiUpstream(secondPrimaryRequests, (res) => {
      writeJson(res, { id: "resp-second", output: [{ content: "second ok" }] });
    });
    const compact = await startUpstream((_req, res) => writeJson(res, { ok: true }));
    const app = await startApp(firstPrimary.url, compact.url);

    const firstProfileId = await saveCodexProfile(app.url, compact.url, "compaction-a", firstPrimary.url);
    const secondProfileId = await saveCodexProfile(app.url, compact.url, "compaction-b", secondPrimary.url);
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyResponse.status).toBe(200);

    const rateLimitedResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: "prime rate limit" }),
      headers: JSON_HEADERS
    });
    expect(rateLimitedResponse.status).toBe(429);
    await rateLimitedResponse.text();

    const compactionInput = [
      { type: "compaction", encrypted_content: "OPAQUE_REMOTE_STATE" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }
    ];
    const firstCompactionResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: compactionInput }),
      headers: JSON_HEADERS
    });
    expect(firstCompactionResponse.status).toBe(200);
    expect(await firstCompactionResponse.text()).toContain("second ok");

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const secondCompactionResponse = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: compactionInput }),
      headers: JSON_HEADERS
    });
    expect(secondCompactionResponse.status).toBe(200);
    expect(await secondCompactionResponse.text()).toContain("second ok");

    expect(firstPrimaryRequests).toHaveLength(1);
    expect(secondPrimaryRequests).toHaveLength(2);
    expect(JSON.parse(secondPrimaryRequests[0].body)).toMatchObject({
      model: "gpt-5.5",
      input: compactionInput
    });
    expect(JSON.parse(secondPrimaryRequests[1].body)).toMatchObject({
      model: "gpt-5.5",
      input: compactionInput
    });
  });
});
