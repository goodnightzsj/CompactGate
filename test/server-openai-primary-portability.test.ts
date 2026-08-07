import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  captureBody,
  type CapturedRequest,
  startApp,
  startAppInDir,
  startUpstream
} from "./helpers/server-test-utils.js";
import { waitForLogEntry } from "./helpers/server-test-logs.js";
import {
  JSON_HEADERS,
  saveCodexProfile,
  startCapturedOpenAiUpstream,
  writeJson,
  writeSse
} from "./server-openai-failover-helpers.js";

function validEncryptedContent(): string {
  const payload = Buffer.alloc(73);
  payload[0] = 0x80;
  return payload.toString("base64url");
}

function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function applyCodexProfile(appUrl: string, profileId: string): Promise<void> {
  const response = await fetch(`${appUrl}/api/config/profiles/apply`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ scope: "codex", profile_id: profileId })
  });
  expect(response.status).toBe(200);
}

async function sendStateFreeSuccess(
  appUrl: string,
  profileId: string | null,
  session: string
): Promise<void> {
  if (profileId) {
    await applyCodexProfile(appUrl, profileId);
  }
  const response = await fetch(`${appUrl}/v1/responses`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-compactgate-session": session },
    body: JSON.stringify({ model: "gpt-5.5", input: "new conversation" })
  });
  expect(response.status).toBe(200);
  await response.text();
}

async function establishOldBinding(
  appUrl: string,
  oldProfileId: string,
  session: string
): Promise<void> {
  await applyCodexProfile(appUrl, oldProfileId);
  const response = await fetch(`${appUrl}/v1/responses`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-compactgate-session": session },
    body: JSON.stringify({ model: "gpt-5.5", input: "remember this session" })
  });
  expect(response.status).toBe(200);
  await response.text();
}

async function setupProfileSwitch(
  oldRespond: (res: ServerResponse) => void,
  nextHandler: Parameters<typeof startUpstream>[0],
  autoSchedule = false
) {
  const oldRequests: CapturedRequest[] = [];
  const oldUpstream = await startCapturedOpenAiUpstream(oldRequests, oldRespond);
  const nextUpstream = await startUpstream(nextHandler);
  const app = await startApp(oldUpstream.url, oldUpstream.url, {
    primary_failover: { auto_schedule: autoSchedule, state_portability: "recover_on_error" }
  });
  const oldProfileId = await saveCodexProfile(
    app.url,
    oldUpstream.url,
    "portable-old",
    oldUpstream.url
  );
  const nextProfileId = await saveCodexProfile(
    app.url,
    oldUpstream.url,
    "portable-next",
    nextUpstream.url
  );
  return {
    app,
    oldRequests,
    oldProfileId,
    nextProfileId,
    oldUpstreamUrl: oldUpstream.url
  };
}

function statefulBody(sessionText = "continue") {
  return {
    model: "gpt-5.5",
    store: false,
    input: [
      {
        type: "reasoning",
        id: "rs_valid",
        encrypted_content: validEncryptedContent(),
        summary: []
      },
      {
        type: "reasoning",
        id: "rs_invalid",
        encrypted_content: null,
        content: null,
        summary: []
      },
      { type: "message", role: "user", content: sessionText }
    ]
  };
}

describe("primary provider-state error recovery", () => {
  it("sends a successful malformed stateful request byte-for-byte exactly once", async () => {
    const requests: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(
      requests,
      (res) => writeJson(res, { id: "resp_original", output: [] })
    );
    const app = await startApp(upstream.url, upstream.url, {
      primary_failover: { auto_schedule: false, state_portability: "recover_on_error" }
    });
    const body = JSON.stringify(statefulBody("accepted unchanged"));

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: JSON_HEADERS,
      body
    });

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toBe(body);
  });

  it("uses direct error-specific recovery for explicit invalid_encrypted_content", async () => {
    const requests: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(requests, (res) => {
      if (requests.length === 1) {
        writeJson(res, { error: { code: "invalid_encrypted_content" } }, 400);
      } else {
        writeJson(res, { id: "resp_recovered", output: [] });
      }
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary_failover: { auto_schedule: false, state_portability: "recover_on_error" }
    });
    const body = JSON.stringify({
      model: "gpt-5.5",
      store: false,
      input: [{
        type: "reasoning",
        id: "rs_foreign",
        encrypted_content: validEncryptedContent(),
        content: null,
        summary: [{ type: "summary_text", text: "keep" }]
      }]
    });

    const response = await fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: JSON_HEADERS,
      body
    });

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toBe(body);
    expect(JSON.parse(requests[1].body)).toMatchObject({
      input: [{ type: "reasoning", summary: [{ type: "summary_text", text: "keep" }] }]
    });
    const log = await waitForLogEntry(
      app.url,
      (entry) => entry.provider_state_portability?.decision === "recovery"
    );
    expect(log.provider_state_portability?.attempts.map((attempt) => attempt.strategy)).toEqual([
      "original",
      "error_400"
    ]);
  });

  it("uses original then CPA then strict after target state-free success", async () => {
    const nextRequests: CapturedRequest[] = [];
    const setup = await setupProfileSwitch(
      (res) => writeJson(res, { id: "resp_old", output: [] }),
      async (req, res) => {
        nextRequests.push({
          method: req.method ?? "POST",
          url: req.url ?? "",
          headers: req.headers,
          body: await captureBody(req)
        });
        if (nextRequests.length === 1) {
          writeJson(res, { id: "resp_target_healthy", output: [] });
        } else if (nextRequests.length <= 3) {
          writeJson(res, { error: { code: "upstream_error", message: "foreign state" } }, 502);
        } else {
          writeJson(res, { id: "resp_next", output: [] });
        }
      },
      true
    );
    await sendStateFreeSuccess(setup.app.url, setup.nextProfileId, "target-health-a");
    await establishOldBinding(setup.app.url, setup.oldProfileId, "portable-session-a");
    await applyCodexProfile(setup.app.url, setup.nextProfileId);
    const body = JSON.stringify(statefulBody());

    const response = await fetch(`${setup.app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "portable-session-a" },
      body
    });

    expect(response.status).toBe(200);
    expect(nextRequests).toHaveLength(4);
    expect(nextRequests[1].body).toBe(body);
    expect(JSON.parse(nextRequests[2].body).input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", id: "rs_valid" }),
      expect.objectContaining({ type: "reasoning", summary: [] })
    ]));
    expect(JSON.parse(nextRequests[3].body).input).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning" })
    ]));
    const log = await waitForLogEntry(
      setup.app.url,
      (entry) => entry.provider_state_portability?.decision === "recovery"
    );
    expect(log.provider_state_portability).toMatchObject({
      trigger: "profile_switch_failure",
      target_state_free_success: true,
      attempts: [
        { strategy: "original", status: 502 },
        { strategy: "cpa", status: 502 },
        { strategy: "cross_domain", status: 200, fidelity: "degraded" }
      ]
    });
  });

  it("can reach strict after direct 400 recovery also fails", async () => {
    const nextRequests: CapturedRequest[] = [];
    const setup = await setupProfileSwitch(
      (res) => writeJson(res, { id: "resp_old", output: [] }),
      async (req, res) => {
        nextRequests.push({
          method: req.method ?? "POST",
          url: req.url ?? "",
          headers: req.headers,
          body: await captureBody(req)
        });
        if (nextRequests.length === 1) {
          writeJson(res, { id: "resp_target_healthy", output: [] });
        } else if (nextRequests.length === 2) {
          writeJson(res, { error: { code: "invalid_encrypted_content" } }, 400);
        } else if (nextRequests.length === 3) {
          writeJson(res, { error: { code: "invalid_encrypted_content" } }, 400);
        } else {
          writeJson(res, { id: "resp_strict_recovered", output: [] });
        }
      }
    );
    await sendStateFreeSuccess(setup.app.url, setup.nextProfileId, "target-health-b");
    await establishOldBinding(setup.app.url, setup.oldProfileId, "portable-session-b");
    await applyCodexProfile(setup.app.url, setup.nextProfileId);
    const body = JSON.stringify({
      model: "gpt-5.5",
      store: false,
      input: [{
        type: "reasoning",
        id: "rs_foreign",
        encrypted_content: validEncryptedContent(),
        content: null,
        summary: []
      }]
    });

    const response = await fetch(`${setup.app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "portable-session-b" },
      body
    });

    expect(response.status).toBe(200);
    expect(nextRequests).toHaveLength(4);
    expect(nextRequests[1].body).toBe(body);
    expect(JSON.parse(nextRequests[2].body).input).toHaveLength(1);
    expect(JSON.parse(nextRequests[3].body).input).toHaveLength(0);
    const log = await waitForLogEntry(
      setup.app.url,
      (entry) => entry.provider_state_portability?.decision === "recovery"
    );
    expect(log.provider_state_portability?.attempts.map((attempt) => attempt.strategy)).toEqual([
      "original",
      "error_400",
      "cross_domain"
    ]);
  });

  it("does not recover a generic 502 without recent target state-free success", async () => {
    const nextRequests: CapturedRequest[] = [];
    const setup = await setupProfileSwitch(
      (res) => writeJson(res, { id: "resp_old", output: [] }),
      async (req, res) => {
        nextRequests.push({
          method: req.method ?? "POST",
          url: req.url ?? "",
          headers: req.headers,
          body: await captureBody(req)
        });
        writeJson(res, { error: { code: "upstream_error" } }, 502);
      }
    );
    await establishOldBinding(setup.app.url, setup.oldProfileId, "portable-session-no-health");
    await applyCodexProfile(setup.app.url, setup.nextProfileId);
    const body = JSON.stringify(statefulBody("no health evidence"));

    const response = await fetch(`${setup.app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "portable-session-no-health" },
      body
    });

    expect(response.status).toBe(502);
    expect(nextRequests).toHaveLength(1);
    expect(nextRequests[0].body).toBe(body);
  });

  it("does not modify or retry an excluded auth failure", async () => {
    const nextRequests: CapturedRequest[] = [];
    const setup = await setupProfileSwitch(
      (res) => writeJson(res, { id: "resp_old", output: [] }),
      async (req, res) => {
        nextRequests.push({
          method: req.method ?? "POST",
          url: req.url ?? "",
          headers: req.headers,
          body: await captureBody(req)
        });
        if (nextRequests.length === 1) {
          writeJson(res, { id: "resp_target_healthy", output: [] });
        } else {
          writeJson(res, { error: { code: "invalid_api_key" } }, 401);
        }
      }
    );
    await sendStateFreeSuccess(setup.app.url, setup.nextProfileId, "target-health-auth");
    await establishOldBinding(setup.app.url, setup.oldProfileId, "portable-session-auth");
    await applyCodexProfile(setup.app.url, setup.nextProfileId);
    const body = JSON.stringify(statefulBody("auth failure"));

    const response = await fetch(`${setup.app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "portable-session-auth" },
      body
    });

    expect(response.status).toBe(401);
    expect(nextRequests).toHaveLength(2);
    expect(nextRequests[1].body).toBe(body);
  });

  it("requires two matching failures for an unknown-source legacy conversation", async () => {
    const requests: CapturedRequest[] = [];
    const upstream = await startCapturedOpenAiUpstream(requests, (res) => {
      if (requests.length === 1) {
        writeJson(res, { id: "resp_target_healthy", output: [] });
      } else if (requests.length <= 4) {
        writeJson(res, { error: { code: "upstream_error" } }, 502);
      } else {
        writeJson(res, { id: "resp_legacy_recovered", output: [] });
      }
    });
    const app = await startApp(upstream.url, upstream.url, {
      primary_failover: { auto_schedule: false, state_portability: "recover_on_error" }
    });
    await sendStateFreeSuccess(app.url, null, "target-health-legacy");
    const body = JSON.stringify(statefulBody("legacy continuation"));
    const sendLegacy = () => fetch(`${app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "portable-legacy" },
      body
    });

    const first = await sendLegacy();
    expect(first.status).toBe(502);
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toBe(body);

    const second = await sendLegacy();
    expect(second.status).toBe(200);
    expect(requests).toHaveLength(5);
    expect(requests[2].body).toBe(body);
    expect(JSON.parse(requests[3].body).input).toHaveLength(3);
    expect(JSON.parse(requests[4].body).input).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning" })
    ]));
  });

  it("does not replay after a 2xx semantic stream has started", async () => {
    const nextRequests: CapturedRequest[] = [];
    const setup = await setupProfileSwitch(
      (res) => writeJson(res, { id: "resp_old", output: [] }),
      async (req, res) => {
        nextRequests.push({
          method: req.method ?? "POST",
          url: req.url ?? "",
          headers: req.headers,
          body: await captureBody(req)
        });
        writeSse(res, [{
          type: "response.failed",
          response: { error: { code: "invalid_encrypted_content" } }
        }]);
      }
    );
    await establishOldBinding(setup.app.url, setup.oldProfileId, "portable-session-stream");
    await applyCodexProfile(setup.app.url, setup.nextProfileId);

    const response = await fetch(`${setup.app.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "portable-session-stream" },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        input: [{ type: "reasoning", encrypted_content: validEncryptedContent() }]
      })
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("response.failed");
    expect(nextRequests).toHaveLength(1);
  });

  it("preserves compressed original wire then recompiles CPA and strict bodies", async () => {
    const nextRequests: Array<{
      betaFeatures: string | undefined;
      encoding: string | undefined;
      body: Buffer;
    }> = [];
    const setup = await setupProfileSwitch(
      (res) => writeJson(res, { id: "resp_gzip_old", output: [] }),
      async (req, res) => {
        nextRequests.push({
          betaFeatures: typeof req.headers["x-codex-beta-features"] === "string"
            ? req.headers["x-codex-beta-features"]
            : undefined,
          encoding: typeof req.headers["content-encoding"] === "string"
            ? req.headers["content-encoding"]
            : undefined,
          body: await readRequestBuffer(req)
        });
        if (nextRequests.length === 1) {
          writeJson(res, { id: "resp_target_healthy", output: [] });
        } else if (nextRequests.length <= 3) {
          writeJson(res, { error: { code: "upstream_error" } }, 502);
        } else {
          writeJson(res, { id: "resp_gzip_next", output: [] });
        }
      }
    );
    await sendStateFreeSuccess(setup.app.url, setup.nextProfileId, "target-health-gzip");
    await establishOldBinding(setup.app.url, setup.oldProfileId, "portable-session-gzip");
    await applyCodexProfile(setup.app.url, setup.nextProfileId);
    const compressedBody = gzipSync(Buffer.from(JSON.stringify(statefulBody("compressed"))));

    const response = await fetch(`${setup.app.url}/v1/responses`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        "content-encoding": "gzip",
        "x-codex-beta-features": "remote_compaction_v2",
        "x-compactgate-session": "portable-session-gzip"
      },
      body: compressedBody
    });

    expect(response.status).toBe(200);
    expect(nextRequests).toHaveLength(4);
    expect(nextRequests[1].encoding).toBe("gzip");
    expect(nextRequests[1].betaFeatures).toBe("remote_compaction_v2");
    expect(nextRequests[1].body).toEqual(compressedBody);
    expect(nextRequests[2].encoding).toBeUndefined();
    expect(nextRequests[2].betaFeatures).toBe("remote_compaction_v2");
    expect(nextRequests[3].encoding).toBeUndefined();
    expect(nextRequests[3].betaFeatures).toBeUndefined();
  });

  it("persists target health and old state-domain binding across restart", async () => {
    const nextRequests: CapturedRequest[] = [];
    const setup = await setupProfileSwitch(
      (res) => writeJson(res, { id: "resp_restart_old", output: [] }),
      async (req, res) => {
        nextRequests.push({
          method: req.method ?? "POST",
          url: req.url ?? "",
          headers: req.headers,
          body: await captureBody(req)
        });
        if (nextRequests.length === 1) {
          writeJson(res, { id: "resp_target_healthy", output: [] });
        } else if (nextRequests.length <= 3) {
          writeJson(res, { error: { code: "upstream_error" } }, 502);
        } else {
          writeJson(res, { id: "resp_restart_next", output: [] });
        }
      }
    );
    await sendStateFreeSuccess(setup.app.url, setup.nextProfileId, "target-health-restart");
    await establishOldBinding(setup.app.url, setup.oldProfileId, "portable-session-restart");
    await setup.app.close();

    const restarted = await startAppInDir(
      setup.app.dir,
      setup.oldUpstreamUrl,
      setup.oldUpstreamUrl,
      { primary_failover: { auto_schedule: false, state_portability: "recover_on_error" } }
    );
    await applyCodexProfile(restarted.url, setup.nextProfileId);
    const body = JSON.stringify(statefulBody("continue after restart"));
    const response = await fetch(`${restarted.url}/v1/responses`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-compactgate-session": "portable-session-restart" },
      body
    });

    expect(response.status).toBe(200);
    expect(nextRequests).toHaveLength(4);
    expect(nextRequests[1].body).toBe(body);
    expect(JSON.parse(nextRequests[3].body).input).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning" })
    ]));
  });
});
