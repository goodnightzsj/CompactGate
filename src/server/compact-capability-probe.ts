import type { IncomingMessage, ServerResponse } from "node:http";
import type { CompactGateConfig, UpstreamProtocol } from "../shared/types.js";
import { countCompactResponseItems } from "./compact-response-normalizer.js";
import { ConfigError } from "./config.js";
import {
  isRecord,
  parseJsonRecord,
  readHeaderString,
  summaryForError
} from "./http-utils.js";
import { buildCompactOpenAiProxyPlan } from "./openai-proxy-plan.js";
import { sendBufferedUpstreamRequest } from "./upstream-client.js";
import { extractResponseUsage } from "./usage.js";
import type { TokenUsageMetrics } from "./usage-types.js";

const MAX_PROBE_RESPONSE_BYTES = 512 * 1024;
const MAX_PROBE_TIMEOUT_MS = 30_000;
const PROBE_PATH = "/v1/responses/compact";
const PROBE_PROMPT = "Compact this probe into one short sentence.";

export interface CompactCapabilityProbeResult {
  supported: boolean;
  protocol: UpstreamProtocol;
  upstream_status: number | null;
  terminal_event: string | null;
  compaction_item_count: number;
  usage: TokenUsageMetrics | null;
  failure_reason: string | null;
}

export async function probeCompactCapability(input: {
  req: IncomingMessage;
  res: ServerResponse;
  config: CompactGateConfig;
  model?: unknown;
}): Promise<CompactCapabilityProbeResult> {
  const model = resolveProbeModel(input.config, input.model);
  const rawBody = Buffer.from(JSON.stringify({
    model,
    stream: true,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: PROBE_PROMPT }]
    }]
  }));
  const protocol = selectedCompactProtocol(input.config);
  if (protocol === "openai_chat") {
    return {
      supported: false,
      protocol,
      upstream_status: null,
      terminal_event: null,
      compaction_item_count: 0,
      usage: null,
      failure_reason: "OpenAI Chat upstream does not expose native Responses compaction."
    };
  }

  try {
    const plan = buildCompactOpenAiProxyPlan({
      config: input.config,
      url: new URL(PROBE_PATH, "http://compactgate.local"),
      headers: {
        "content-type": "application/json",
        "accept-encoding": "identity"
      },
      rawBody,
      nativeCompaction: true
    });
    plan.requestHeaders["accept-encoding"] = "identity";
    const result = await sendBufferedUpstreamRequest({
      req: input.req,
      res: input.res,
      upstream: plan.upstream,
      startedAt: performance.now(),
      timeoutMs: Math.min(plan.timeoutMs, MAX_PROBE_TIMEOUT_MS),
      timeoutMessage: plan.timeoutMessage,
      requestHeaders: plan.requestHeaders,
      proxyUrl: plan.proxyUrl,
      body: plan.upstreamBody,
      extraResponseHeaders: {},
      writeResponse: false,
      maxBufferedResponseBytes: MAX_PROBE_RESPONSE_BYTES,
      maxObservedStreamEventBytes: MAX_PROBE_RESPONSE_BYTES,
      streamProtocol: protocol === "anthropic_messages" ? "anthropic" : "openai"
    });
    const compactionItemCount = countProbeCompactionItems(
      protocol,
      result.responseBody,
      result.responseHeaders
    );
    const usage = extractResponseUsage(result.responseBody, result.responseHeaders);
    const failureReason = probeFailureReason({
      protocol,
      status: result.status,
      responseBodyTruncated: result.responseBodyTruncated,
      compactionItemCount,
      terminalEvent: result.streamSummary?.terminalEvent ?? null,
      sawTerminalEvent: result.streamSummary?.sawTerminalEvent ?? false,
      sse: isSseResponse(result.responseHeaders),
      errorSummary: result.errorSummary
    });

    return {
      supported: failureReason === null,
      protocol,
      upstream_status: result.status,
      terminal_event: result.streamSummary?.terminalEvent ?? null,
      compaction_item_count: compactionItemCount,
      usage: hasUsage(usage) ? usage : null,
      failure_reason: failureReason
    };
  } catch (error) {
    return {
      supported: false,
      protocol,
      upstream_status: null,
      terminal_event: null,
      compaction_item_count: 0,
      usage: null,
      failure_reason: summaryForError(error)
    };
  }
}

function resolveProbeModel(config: CompactGateConfig, requested: unknown): string {
  if (requested !== undefined && (typeof requested !== "string" || requested.trim().length === 0)) {
    throw new ConfigError("compact capability probe model must be a non-empty string.");
  }
  const model = typeof requested === "string"
    ? requested.trim()
    : config.primary.model_override?.trim() ||
      (config.compact.model_mode === "custom" ? config.compact.model_override.trim() : "");
  if (!model) {
    throw new ConfigError("compact capability probe requires model or a configured model override.");
  }
  return model;
}

function selectedCompactProtocol(config: CompactGateConfig): UpstreamProtocol {
  return config.compact.upstream_mode === "split"
    ? config.compact.upstream_protocol
    : config.primary.upstream_protocol;
}

function probeFailureReason(input: {
  protocol: UpstreamProtocol;
  status: number;
  responseBodyTruncated: boolean;
  compactionItemCount: number;
  terminalEvent: string | null;
  sawTerminalEvent: boolean;
  sse: boolean;
  errorSummary: string | null;
}): string | null {
  if (input.status < 200 || input.status >= 300) {
    return input.errorSummary ?? `Upstream returned HTTP ${input.status}.`;
  }
  if (input.responseBodyTruncated) {
    return `Capability probe response exceeded ${MAX_PROBE_RESPONSE_BYTES} bytes.`;
  }
  if (input.terminalEvent === "response.failed" || input.terminalEvent === "response.incomplete") {
    return `Capability probe ended with ${input.terminalEvent}.`;
  }
  if (input.compactionItemCount === 0) {
    return "Capability probe response did not include a compaction item.";
  }
  if (input.sse && !input.sawTerminalEvent) {
    return "Capability probe stream ended without a terminal event.";
  }
  if (
    input.sse &&
    input.protocol === "openai_responses" &&
    input.terminalEvent !== "response.completed" &&
    input.terminalEvent !== "[DONE]"
  ) {
    return `Capability probe ended with ${input.terminalEvent ?? "an unknown event"}.`;
  }
  if (input.sse && input.protocol === "anthropic_messages" && input.terminalEvent !== "message_stop") {
    return `Capability probe ended with ${input.terminalEvent ?? "an unknown event"}.`;
  }
  return null;
}

function isSseResponse(headers: Record<string, string | string[] | undefined>): boolean {
  return (readHeaderString(headers["content-type"]) ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

function countProbeCompactionItems(
  protocol: UpstreamProtocol,
  body: Buffer,
  headers: Record<string, string | string[] | undefined>
): number {
  if (protocol === "openai_responses") {
    return countCompactResponseItems(body, headers);
  }

  const parsed = parseJsonRecord(body);
  if (parsed) {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    return content.filter((item) => isRecord(item) && item.type === "compaction").length;
  }

  let count = 0;
  for (const line of body.toString("utf8").split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    try {
      const event = JSON.parse(line.slice(5).trim()) as unknown;
      if (
        isRecord(event) &&
        event.type === "content_block_start" &&
        isRecord(event.content_block) &&
        event.content_block.type === "compaction"
      ) {
        count += 1;
      }
    } catch {
      continue;
    }
  }
  return count;
}

function hasUsage(usage: TokenUsageMetrics): boolean {
  return Object.values(usage).some((value) => typeof value === "number");
}
