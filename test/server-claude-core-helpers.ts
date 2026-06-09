import type { IncomingMessage, ServerResponse } from "node:http";
import {
  captureBody,
  type CapturedRequest,
  startClaudeUpstream
} from "./helpers/server-test-utils.js";

export const JSON_HEADERS = { "content-type": "application/json" };
export const CLAUDE_HEADERS = {
  ...JSON_HEADERS,
  "anthropic-version": "2023-06-01"
};

type CaptureTarget = CapturedRequest[] | { current: CapturedRequest | null };

export async function fetchJson<T>(
  url: string,
  method: "GET" | "POST",
  body?: unknown
): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, {
    method,
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  return {
    response,
    body: (await response.json()) as T
  };
}

export function postClaudeMessage(
  appUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = CLAUDE_HEADERS
): Promise<Response> {
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers
  });
}

export async function startCapturedClaudeUpstream(
  target: CaptureTarget,
  respond: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
) {
  return startClaudeUpstream(async (req, res) => {
    const captured = {
      method: req.method ?? "POST",
      url: req.url ?? "",
      headers: req.headers,
      body: await captureBody(req)
    };
    if (Array.isArray(target)) {
      target.push(captured);
    } else {
      target.current = captured;
    }
    await respond(req, res);
  });
}

export function writeJsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
