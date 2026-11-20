import type { CaptureRecord, RequestLogEntry } from "../../shared/types.js";
import { isRecord } from "../../shared/records.js";

export class CaptureRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly captureStatus: RequestLogEntry["capture_status"] | null
  ) {
    super(message);
  }
}

export async function fetchCaptureRecord(
  requestId: string,
  signal?: AbortSignal
): Promise<CaptureRecord> {
  const response = await fetch(captureViewUrl(requestId), {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    signal
  });
  signal?.throwIfAborted();
  const payload = await readJsonPayload(response);
  if (response.status !== 200) {
    throw new CaptureRequestError(
      readError(payload) ?? response.statusText,
      response.status,
      readCaptureStatus(payload)
    );
  }

  if (!isRecord(payload)) throw new TypeError("Capture response must be a JSON object.");
  return payload as unknown as CaptureRecord;
}

export function captureDownloadUrl(requestId: string): string {
  return `/api/logs/${encodeURIComponent(requestId)}/capture/download`;
}

function captureViewUrl(requestId: string): string {
  return `/api/logs/${encodeURIComponent(requestId)}/capture`;
}

async function readJsonPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (response.status === 200 || !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function readError(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
}

function readCaptureStatus(payload: unknown): RequestLogEntry["capture_status"] | null {
  if (!isRecord(payload)) {
    return null;
  }
  const value = payload.capture_status;
  return value === "none" || value === "pending" || value === "present" || value === "purged"
    ? value
    : null;
}
