import type { ServerResponse } from "node:http";
import { captureBody } from "./server-test-capture.js";
import { startUpstream } from "./server-test-upstreams.js";

export {
  assertCaptured,
  captureRequest,
  type CapturedRequest,
  waitForCaptureRecords
} from "./server-test-capture.js";
export {
  fetchLogPage,
  fetchRecentLogs,
  readLatestLogBodyFields,
  readLogCount,
  seedLegacyLogDatabase,
  sendCompactRequest,
  waitForLogEntry
} from "./server-test-logs.js";
export {
  cleanup,
  cleanupEnvKeys,
  setEnv,
  startApp,
  startAppInDir
} from "./server-test-lifecycle.js";
export {
  startClaudeUpstream,
  startCapturedOpenAiUpstream,
  startConnectProxy,
  startHttpsClaudeUpstream
} from "./server-test-upstreams.js";
export { openSseStream } from "./server-test-sse.js";
export { captureBody, startUpstream };

export const JSON_HEADERS = { "content-type": "application/json" };

export async function fetchJson<T>(
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { response, body: (await response.json()) as T };
}

export function postJson(
  appUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { ...JSON_HEADERS, ...headers }
  });
}

export function writeJsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

export function startJsonUpstream(body: unknown, status = 200) {
  return startUpstream(async (req, res) => {
    await captureBody(req);
    writeJsonResponse(res, body, status);
  });
}

export function claudeManualCompactPrompt() {
  return [
    "Your task is to create a detailed summary of the conversation so far.",
    "CRITICAL: Respond with TEXT ONLY.",
    "<summary>",
    "Summarize the previous context.",
    "</summary>"
  ].join("\n");
}
