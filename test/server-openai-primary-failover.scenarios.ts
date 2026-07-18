import { describe, expect, it } from "vitest";
import type { PublicConfig } from "../src/shared/types.js";
import {
  captureBody,
  type CapturedRequest,
  fetchLogPage,
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
  it("uses supplied route-preview headers for primary session stickiness", async () => {
    const firstPrimary = await startCapturedOpenAiUpstream([], (res) => writeJson(res, { ok: "first" }));
    const secondPrimary = await startCapturedOpenAiUpstream([], (res) => writeJson(res, { ok: "second" }));
    const app = await startApp(firstPrimary.url, firstPrimary.url);

    const firstProfileId = await saveCodexProfile(
      app.url,
      firstPrimary.url,
      "preview-primary-a",
      firstPrimary.url,
      "preview-model-a"
    );
    const secondProfileId = await saveCodexProfile(
      app.url,
      firstPrimary.url,
      "preview-primary-b",
      secondPrimary.url,
      "preview-model-b"
    );
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applySecond = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: secondProfileId })
    });
    expect(applySecond.status).toBe(200);

    const stickyRequest = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "preview-session" },
      body: JSON.stringify({ model: "gpt-5.5", input: "remember preview session" })
    });
    expect(stickyRequest.status).toBe(200);
    await stickyRequest.text();

    const applyFirst = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyFirst.status).toBe(200);

    const previewResponse = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        path: "/v1/responses",
        headers: { "x-compactgate-session": "preview-session" },
        body: { model: "gpt-5.5", input: "preview with session" }
      })
    });
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      upstream_host: new URL(secondPrimary.url).host,
      target_model: "preview-model-b"
    });
  });

  it("uses primary failover selection for remote V1 compact previews in primary mode", async () => {
    const firstPrimary = await startCapturedOpenAiUpstream([], (res) => writeJson(res, { ok: "first" }));
    const secondPrimary = await startCapturedOpenAiUpstream([], (res) => writeJson(res, { ok: "second" }));
    const app = await startApp(firstPrimary.url, firstPrimary.url, {
      compact: { upstream_mode: "primary" }
    });

    const firstProfileId = await saveCodexProfile(
      app.url,
      firstPrimary.url,
      "preview-compact-a",
      firstPrimary.url,
      "model-a",
      "primary"
    );
    const secondProfileId = await saveCodexProfile(
      app.url,
      firstPrimary.url,
      "preview-compact-b",
      secondPrimary.url,
      "model-b",
      "primary"
    );
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applySecond = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: secondProfileId })
    });
    expect(applySecond.status).toBe(200);

    const stickyRequest = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "preview-compact-session" },
      body: JSON.stringify({ model: "gpt-5.5", input: "remember compact preview session" })
    });
    expect(stickyRequest.status).toBe(200);
    await stickyRequest.text();

    const applyFirst = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyFirst.status).toBe(200);

    const previewResponse = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        path: "/v1/responses/compact",
        headers: { "x-compactgate-session": "preview-compact-session" },
        body: { model: "gpt-5.5", input: "compact preview" }
      })
    });
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      upstream_host: new URL(secondPrimary.url).host,
      target_model: "model-b-openai-compact"
    });
  });

  it("fails over Codex primary streams after more than ten empty 200 responses without touching compact routing", async () => {
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

    const firstProfileId = await saveCodexProfile(
      app.url,
      compact.url,
      "primary-a",
      firstPrimary.url,
      "model-a"
    );
    const secondProfileId = await saveCodexProfile(
      app.url,
      compact.url,
      "primary-b",
      secondPrimary.url,
      "model-b"
    );
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyResponse.status).toBe(200);

    for (let index = 0; index < 11; index += 1) {
      const response = await fetch(`${app.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", stream: true, input: `empty ${index}` }),
        headers: JSON_HEADERS
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    }

    const previewResponse = await fetch(`${app.url}/api/test-route`, {
      method: "POST",
      body: JSON.stringify({
        path: "/v1/responses",
        body: { model: "gpt-5.5", stream: true, input: "preview failover" }
      }),
      headers: JSON_HEADERS
    });
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      upstream_host: new URL(secondPrimary.url).host,
      target_model: "model-b"
    });
    const configBeforeFailoverRequest = await fetch(`${app.url}/api/config`);
    expect((await configBeforeFailoverRequest.json() as PublicConfig).profile_scopes.codex.active_profile_id)
      .toBe(firstProfileId);

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

    expect(firstPrimaryRequests).toHaveLength(11);
    expect(secondPrimaryRequests).toHaveLength(1);
    expect(compactRequests).toHaveLength(1);
    expect(JSON.parse(secondPrimaryRequests[0].body)).toMatchObject({
      model: "model-b",
      stream: true,
      input: "after failover"
    });
    expect(JSON.parse(compactRequests[0].body)).toMatchObject({
      model: "model-b-openai-compact",
      input: "compact untouched"
    });
    const configAfterFailover = await fetch(`${app.url}/api/config`);
    const publicConfigAfterFailover = await configAfterFailover.json() as PublicConfig;
    expect(publicConfigAfterFailover.profile_scopes.codex.active_profile_id).toBe(secondProfileId);

    const logs = await fetchRecentLogs(app.url);
    expect(logs.filter((entry) => entry.upstream_host === new URL(firstPrimary.url).host)).toHaveLength(11);
    expect(logs.find((entry) => entry.error_summary === "OpenAI stream closed before response.completed.")).toMatchObject({
      route: "primary",
      status: 200,
      upstream_status: 200,
      stream_terminal_event: null,
      stream_outcome: "upstream_stream_incomplete",
      response_model: null,
      response_model_source: "unavailable",
      upstream_host: new URL(firstPrimary.url).host,
      error_summary: "OpenAI stream closed before response.completed."
    });
    expect(logs.find((entry) => entry.upstream_host === new URL(secondPrimary.url).host)).toMatchObject({
      route: "primary",
      status: 200,
      upstream_host: new URL(secondPrimary.url).host,
      error_summary: null,
      target_model: "model-b"
    });
    expect(logs.find((entry) => entry.upstream_host === new URL(compact.url).host)).toMatchObject({
      route: "compact",
      status: 200,
      upstream_host: new URL(compact.url).host,
      error_summary: null
    });
  });

  it("fails over Codex primary streams after more than ten output-only 200 responses without completion", async () => {
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

    for (let index = 0; index < 11; index += 1) {
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

    expect(firstPrimaryRequests).toHaveLength(11);
    expect(secondPrimaryRequests).toHaveLength(1);

    const logs = await fetchRecentLogs(app.url);
    expect(logs.find((entry) => entry.upstream_host === new URL(firstPrimary.url).host)).toMatchObject({
      route: "primary",
      status: 200,
      upstream_status: 200,
      stream_terminal_event: null,
      stream_outcome: "upstream_stream_incomplete",
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

  it("keeps token-bearing failed stream diagnostics on the same primary profile", async () => {
    const firstPrimaryRequests: CapturedRequest[] = [];
    const secondPrimaryRequests: CapturedRequest[] = [];
    const firstPrimary = await startCapturedOpenAiUpstream(firstPrimaryRequests, (res) => writeSse(res, [
      {
        type: "response.failed",
        response: {
          usage: {
            input_tokens: 9,
            output_tokens: 2,
            total_tokens: 11
          }
        }
      }
    ]));
    const secondPrimary = await startCapturedOpenAiUpstream(secondPrimaryRequests, (res) => writeSse(res, [
      { type: "response.output_text.delta", delta: "second ok" },
      { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
    ]));
    const compact = await startUpstream((_req, res) => writeJson(res, { ok: true }));
    const app = await startApp(firstPrimary.url, compact.url);

    const firstProfileId = await saveCodexProfile(app.url, compact.url, "token-failed-a", firstPrimary.url);
    const secondProfileId = await saveCodexProfile(app.url, compact.url, "token-failed-b", secondPrimary.url);
    expect(firstProfileId).toBeTruthy();
    expect(secondProfileId).toBeTruthy();

    const applyResponse = await fetch(`${app.url}/api/config/profiles/apply`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: "codex", profile_id: firstProfileId })
    });
    expect(applyResponse.status).toBe(200);

    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${app.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", stream: true, input: `token failed ${index}` }),
        headers: JSON_HEADERS
      });
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(firstPrimaryRequests).toHaveLength(5);
    expect(secondPrimaryRequests).toHaveLength(0);

    const logPage = await fetchLogPage(app.url);
    expect(logPage.status_counts).toEqual({
      all: 5,
      normal: 5,
      error: 0
    });
    expect(logPage.logs[0]).toMatchObject({
      route: "primary",
      status: 200,
      upstream_status: 200,
      stream_terminal_event: "response.failed",
      stream_outcome: "upstream_stream_incomplete",
      response_model: null,
      response_model_source: "unavailable",
      upstream_host: new URL(firstPrimary.url).host,
      input_tokens: 9,
      output_tokens: 2,
      total_tokens: 11,
      error_summary: "OpenAI stream ended with response.failed."
    });

    const errorPage = await fetchLogPage(app.url, "?status=error");
    expect(errorPage.logs).toHaveLength(0);
  });

  it("avoids a Codex primary profile after more than ten account-level failures without touching compact routing", async () => {
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

    for (let index = 0; index < 11; index += 1) {
      const failingResponse = await fetch(`${app.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", input: `account failure ${index}` }),
        headers: JSON_HEADERS
      });
      expect(failingResponse.status).toBe(403);
      await failingResponse.text();
    }

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

    expect(firstPrimaryRequests).toHaveLength(11);
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
      if (firstPrimaryRequests.length <= 11) {
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

    for (let index = 0; index < 11; index += 1) {
      const rateLimitedResponse = await fetch(`${app.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5", input: `prime rate limit ${index}` }),
        headers: JSON_HEADERS
      });
      expect(rateLimitedResponse.status).toBe(429);
      await rateLimitedResponse.text();
    }

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

    expect(firstPrimaryRequests).toHaveLength(11);
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
