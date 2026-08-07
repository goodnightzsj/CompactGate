import type { IncomingMessage, ServerResponse } from "node:http";
import {
  captureRequest,
  type CapturedRequest,
  JSON_HEADERS,
  startClaudeUpstream,
  writeJsonResponse
} from "./helpers/server-test-utils.js";

export { fetchJson } from "./helpers/server-test-utils.js";
export { JSON_HEADERS, writeJsonResponse };

export const CLAUDE_HEADERS = {
  ...JSON_HEADERS,
  "anthropic-version": "2023-06-01"
};

type CaptureTarget = CapturedRequest[] | { current: CapturedRequest | null };

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
    const captured = await captureRequest(req);
    if (Array.isArray(target)) {
      target.push(captured);
    } else {
      target.current = captured;
    }
    await respond(req, res);
  });
}
