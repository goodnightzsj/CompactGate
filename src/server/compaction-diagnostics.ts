import type { IncomingHttpHeaders } from "node:http";
import type {
  CompactionDiagnostics,
  OpenAiCompactionMode
} from "../shared/types.js";
import { countCompactResponseItems } from "./compact-response-normalizer.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";
import { compactionImplementation } from "./routing.js";

export function buildCompactionDiagnostics(input: {
  mode: OpenAiCompactionMode;
  requestBody: Buffer;
  requestHeaders: IncomingHttpHeaders;
  responseBody: Buffer;
  responseHeaders: IncomingHttpHeaders;
}): CompactionDiagnostics {
  const request = parseJsonRecord(input.requestBody);
  const items = Array.isArray(request?.input) ? request.input : [];
  return {
    implementation: compactionImplementation(input.mode, request, input.requestHeaders),
    request_item_count: countItems(items, "compaction"),
    request_trigger_count: countItems(items, "compaction_trigger"),
    response_item_count: countCompactResponseItems(input.responseBody, input.responseHeaders)
  };
}

function countItems(items: unknown[], type: string): number {
  return items.filter((item) => isRecord(item) && item.type === type).length;
}
