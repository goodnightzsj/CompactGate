import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  assertCaptured,
  captureBody,
  type CapturedRequest,
  setEnv,
  startApp,
  startUpstream
} from "./helpers/server-test-utils.js";

const JSON_HEADERS = { "content-type": "application/json" };

async function fetchJson<T = any>(
  url: string,
  method: "GET" | "PATCH" = "GET",
  body?: unknown
): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: JSON_HEADERS,
          body: JSON.stringify(body)
        })
  });

  return {
    response,
    body: (await response.json()) as T
  };
}

function postJson(appUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: JSON_HEADERS
  });
}

async function startCapturedJsonUpstream(target: { current: CapturedRequest | null }) {
  return startUpstream(async (req, res) => {
    target.current = await captureRequest(req);
    writeJsonResponse(res, { ok: true });
  });
}

async function captureRequest(req: IncomingMessage): Promise<CapturedRequest> {
  return {
    method: req.method ?? "POST",
    url: req.url ?? "",
    headers: req.headers,
    body: await captureBody(req)
  };
}

function writeJsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

describe("CompactGate config API", () => {
  it("updates api_key_env names and reports the active credential scope", async () => {
    const app = await startApp(undefined, undefined, {
      compact: {
        upstream_mode: "primary"
      }
    });

    const { response: configResponse, body: configBody } = await fetchJson(
      `${app.url}/api/config`,
      "PATCH",
      {
        primary: { api_key_env: "TEST_PRIMARY_RUNTIME_KEY" },
        compact: { api_key_env: "TEST_COMPACT_RUNTIME_KEY" }
      }
    );

    expect(configResponse.status).toBe(200);
    expect(configBody.primary.api_key_env).toBe("TEST_PRIMARY_RUNTIME_KEY");
    expect(configBody.primary.stored_api_key).toBe(false);
    expect(configBody.primary.active_api_key_env).toBe("TEST_PRIMARY_RUNTIME_KEY");
    expect(configBody.primary.api_key_source).toBe("missing");
    expect(configBody.compact.api_key_env).toBe("TEST_COMPACT_RUNTIME_KEY");
    expect(configBody.compact.stored_api_key).toBe(false);

    const { body: healthBody } = await fetchJson(`${app.url}/api/health`);

    expect(healthBody.compact.api_key_env).toBe("TEST_COMPACT_RUNTIME_KEY");
    expect(healthBody.compact.stored_api_key).toBe(false);
    expect(healthBody.compact.active_credential_scope).toBe("primary");
    expect(healthBody.compact.active_api_key_env).toBe("TEST_PRIMARY_RUNTIME_KEY");
    expect(healthBody.compact.api_key_source).toBe("missing");
  });

  it("prefers saved direct API keys over environment variables without exposing plaintext secrets", async () => {
    const primaryEnv = "PRIMARY_RUNTIME_AUTH_KEY";
    const compactEnv = "COMPACT_RUNTIME_AUTH_KEY";
    setEnv(primaryEnv, "env-primary-key");
    setEnv(compactEnv, "env-compact-key");

    const primaryCapture: { current: CapturedRequest | null } = { current: null };
    const compactCapture: { current: CapturedRequest | null } = { current: null };
    const primary = await startCapturedJsonUpstream(primaryCapture);
    const compact = await startCapturedJsonUpstream(compactCapture);
    const app = await startApp(primary.url, compact.url, {
      primary: {
        api_key: "saved-primary-key",
        api_key_env: primaryEnv
      },
      compact: {
        api_key: "saved-compact-key",
        api_key_env: compactEnv
      }
    });

    const primaryResponse = await postJson(app.url, "/v1/responses", { model: "gpt-5.5" });
    expect(primaryResponse.status).toBe(200);
    await primaryResponse.text();

    const compactResponse = await postJson(app.url, "/v1/responses/compact", {
      model: "gpt-5.5"
    });
    expect(compactResponse.status).toBe(200);
    await compactResponse.text();

    assertCaptured(primaryCapture.current);
    assertCaptured(compactCapture.current);
    expect(primaryCapture.current.headers.authorization).toBe("Bearer saved-primary-key");
    expect(compactCapture.current.headers.authorization).toBe("Bearer saved-compact-key");

    const { body: configBody } = await fetchJson(`${app.url}/api/config`);
    const { response: exportResponse, body: exportBody } = await fetchJson(
      `${app.url}/api/config/export`
    );
    const { body: healthBody } = await fetchJson(`${app.url}/api/health`);

    expect(configBody.primary.api_key_source).toBe("config");
    expect(configBody.primary.stored_api_key).toBe(true);
    expect(configBody.primary.active_api_key_env).toBeNull();
    expect("api_key" in configBody.primary).toBe(false);
    expect(configBody.compact.api_key_source).toBe("config");
    expect(configBody.compact.stored_api_key).toBe(true);
    expect(configBody.compact.active_api_key_env).toBeNull();
    expect("api_key" in configBody.compact).toBe(false);
    expect(exportResponse.status).toBe(200);
    expect(exportBody.primary.api_key).toBe("saved-primary-key");
    expect(exportBody.compact.api_key).toBe("saved-compact-key");
    expect(healthBody.primary.api_key_source).toBe("config");
    expect(healthBody.primary.stored_api_key).toBe(true);
    expect(healthBody.compact.api_key_source).toBe("config");
    expect(healthBody.compact.stored_api_key).toBe(true);
    expect(JSON.stringify(configBody)).not.toContain("saved-primary-key");
    expect(JSON.stringify(healthBody)).not.toContain("saved-primary-key");
  });
});
