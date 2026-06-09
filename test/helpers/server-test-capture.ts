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

export interface CaptureFixtureRecord {
  route: string;
  source_model: string | null;
  target_model: string | null;
  compact_bridge_replacements: number;
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

export async function readCaptureRecords(dir: string) {
  const names = (await readdir(dir)).sort();
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(path.join(dir, name), "utf8")) as CaptureFixtureRecord
    )
  );
}

export async function waitForCaptureRecords(dir: string, minCount: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const records = await readCaptureRecords(dir);
    if (records.length >= minCount) {
      return records;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return readCaptureRecords(dir);
}
