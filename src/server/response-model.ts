import type { IncomingHttpHeaders } from "node:http";
import type { ResponseModelSource } from "../shared/types.js";
import { decodeResponseText } from "./usage-utils.js";
import { isRecord } from "../shared/records.js";
import { createSseFrameDecoder, SSE_LINE_ENDING, sseDataFrames } from "./sse-frames.js";

export function extractResponseModelFromBodies(
  upstreamResponseBody: Buffer,
  clientResponseBody: Buffer | null,
  upstreamResponseHeaders: IncomingHttpHeaders = {},
  clientResponseHeaders: IncomingHttpHeaders = {}
): string | null {
  return (
    extractResponseModelFromText(decodeResponseText(upstreamResponseBody, upstreamResponseHeaders) ?? "") ??
    extractResponseModelFromText(
      clientResponseBody
        ? decodeResponseText(clientResponseBody, clientResponseHeaders) ?? ""
        : ""
    )
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
  let lastModel: string | null = null;
  let completed = false;
  const decoder = createSseFrameDecoder(frame => {
    if (completed) return;
    const eventName = frame.split(SSE_LINE_ENDING).reverse().find(line => line.startsWith("event:"))?.slice(6).trim();
    for (const data of sseDataFrames(frame)) {
      try {
        const event = JSON.parse(data) as unknown;
        const model = extractModelFromResponseObject(event);
        if (!model) continue;
        lastModel = model;
        completed = isRecord(event) && event.type === "response.completed" || eventName === "response.completed";
      } catch {
        continue;
      }
    }
  });
  decoder.write(Buffer.from(text));
  decoder.end();

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

function readModel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();
  return text.length > 0 ? text : null;
}
