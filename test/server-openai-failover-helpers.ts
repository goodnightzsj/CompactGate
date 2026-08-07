import type { ServerResponse } from "node:http";
import { expect } from "vitest";
import type { PublicConfig } from "../src/shared/types.js";
import {
  captureRequest,
  type CapturedRequest,
  JSON_HEADERS,
  startUpstream,
  writeJsonResponse
} from "./helpers/server-test-utils.js";

export { JSON_HEADERS, writeJsonResponse as writeJson };

export async function saveCodexProfile(
  appUrl: string,
  compactUrl: string,
  name: string,
  primaryBaseUrl: string,
  modelOverride?: string,
  compactUpstreamMode: "split" | "primary" = "split"
): Promise<string> {
  const response = await fetch(`${appUrl}/api/config/profiles`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      scope: "codex",
      name,
      config: {
        primary: {
          base_url: primaryBaseUrl,
          api_key: `${name}-token`,
          ...(modelOverride ? { model_override: modelOverride } : {})
        },
        compact: { base_url: compactUrl, api_key: "compact-token", upstream_mode: compactUpstreamMode }
      }
    })
  });
  const body = (await response.json()) as PublicConfig;

  expect(response.status).toBe(200);
  return body.profile_scopes.codex.profiles.find((profile) => profile.name === name)?.id ?? "";
}

export async function startCapturedOpenAiUpstream(
  requests: CapturedRequest[],
  respond: (res: ServerResponse) => void
) {
  return startUpstream(async (req, res) => {
    requests.push(await captureRequest(req));
    respond(res);
  });
}

export function writeSse(res: ServerResponse, events: unknown[] = []): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.length > 0 ? `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n` : "");
}
