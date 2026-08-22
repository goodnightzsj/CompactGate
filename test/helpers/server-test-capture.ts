import { readFile, readdir } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { expect } from "vitest";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface CaptureFixtureRecord {
  request_id: string;
  time: string;
  completed_at: string;
  route: string;
  method: string;
  path: string;
  upstream_url: string;
  upstream_host: string;
  source_model: string | null;
  target_model: string | null;
  compact_bridge_replacements: number;
  compact_response_normalized: boolean;
  compact_response_normalize_reason: string | null;
  compact_response_synthetic_source: string | null;
  incoming_request: {
    headers: Record<string, string | string[]>;
    body: {
      byte_length: number;
      captured_byte_length: number;
      truncated: boolean;
      text: string;
      base64: string;
    };
  };
  upstream_request: {
    headers: Record<string, string | string[]>;
    body: {
      byte_length: number;
      captured_byte_length: number;
      truncated: boolean;
      text: string;
      base64: string;
    };
  };
  upstream_response: {
    headers: Record<string, string | string[]>;
    status: number;
    body: {
      byte_length: number;
      captured_byte_length: number;
      truncated: boolean;
      text: string;
      base64: string;
    };
  };
  client_response: {
    headers: Record<string, string | string[]>;
    status: number;
    body: {
      byte_length: number;
      captured_byte_length: number;
      truncated: boolean;
      text: string;
      base64: string;
    };
  } | null;
}

export function assertCaptured(request: CapturedRequest | null): asserts request is CapturedRequest {
  expect(request).not.toBeNull();
}

export function captureBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function captureRequest(req: IncomingMessage): Promise<CapturedRequest> {
  return {
    method: req.method ?? "POST",
    url: req.url ?? "",
    headers: req.headers,
    body: await captureBody(req)
  };
}

export async function readCaptureRecords(dir: string) {
  const names = (await readdir(dir)).sort();
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(path.join(dir, name), "utf8")) as CaptureFixtureRecord
    )
  );
}

/**
 * Captures are written asynchronously after the response is sent, so every
 * assertion about one has to wait for the file. The budget is generous because
 * the whole suite runs 80+ files in parallel: the old 20 × 25ms = 500ms ceiling
 * expired under load and returned an empty list, which surfaced as a confusing
 * `undefined` destructure rather than a timeout, and a false failure like that
 * hides real ones. A capture that lands promptly still returns on the first poll.
 */
export async function waitForCaptureRecords(dir: string, minCount: number) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const records = await readCaptureRecords(dir);
    if (records.length >= minCount) {
      return records;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return readCaptureRecords(dir);
}
