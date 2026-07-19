import { decodeBodyText } from "./http-utils.js";
import type { ResponseModelSource } from "../shared/types.js";

export function extractResponseModelFromBodies(
  upstreamResponseBody: Buffer,
  clientResponseBody: Buffer | null
): string | null {
  return (
    extractResponseModelFromText(decodeBodyText(upstreamResponseBody)) ??
    extractResponseModelFromText(clientResponseBody ? decodeBodyText(clientResponseBody) : "")
  );
}

export function effectiveResponseModel(
  responseModel: string | null,
  targetModel: string | null,
  source: ResponseModelSource
): string | null {
  if (responseModel) {
    return responseModel;
  }

  return source === "target_fallback" ? targetModel : null;
}

export function extractResponseModelFromText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const jsonModel = extractJsonResponseModel(trimmed);
  if (jsonModel) {
    return jsonModel;
  }

  return extractSseResponseModel(trimmed);
}

function extractJsonResponseModel(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return extractModelFromResponseObject(parsed);
  } catch {
    return null;
  }
}

function extractSseResponseModel(text: string): string | null {
  let currentEvent = "";
  let lastModel: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim();
      continue;
    }

    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const event = JSON.parse(data) as unknown;
      const model = extractModelFromResponseObject(event);
      if (!model) {
        continue;
      }

      lastModel = model;
      if (currentEvent === "response.completed" || eventType(event) === "response.completed") {
        return model;
      }
    } catch {
      continue;
    }
  }

  return lastModel;
}

function extractModelFromResponseObject(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const responseModel = isRecord(value.response) ? readModel(value.response.model) : null;
  const messageModel = isRecord(value.message) ? readModel(value.message.model) : null;
  return responseModel ?? messageModel ?? readModel(value.model);
}

function eventType(value: unknown): string | null {
  return isRecord(value) && typeof value.type === "string" ? value.type : null;
}

function readModel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  return text.length > 0 ? text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
