import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CompactGateConfig, UpstreamProtocol } from "../shared/types.js";
import type { ClientIdentityStore } from "./client-identity-store.js";
import { countCompactResponseItems } from "./compact-response-normalizer.js";
import { ConfigError } from "./config.js";
import {
  isRecord,
  parseJsonRecord,
  readHeaderString,
  summaryForError
} from "./http-utils.js";
import { buildCompactOpenAiProxyPlan } from "./openai-proxy-plan.js";
import { sendBufferedUpstreamRequest, type BufferedUpstreamResult } from "./upstream-client.js";
import { extractResponseUsage } from "./usage.js";
import { decodeResponseText } from "./usage-utils.js";
import type { TokenUsageMetrics } from "./usage-types.js";
import type { OAuthStore } from "./oauth-store.js";
import { prepareOAuthRequest } from "./oauth-transport.js";
import { createCodexResponseTransform } from "./oauth-response.js";
import { createOpenAiStreamObserver } from "./upstream-openai-stream.js";
import { appendBufferedResponseChunk } from "./upstream-response-buffer.js";
import { sseDataFrames } from "./sse-frames.js";

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
  clientIdentity?: ClientIdentityStore;
  oauth?: OAuthStore;
}): Promise<CompactCapabilityProbeResult> {
  const startedAt = performance.now();
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
      nativeCompaction: true,
      clientIdentity: input.clientIdentity
    });
    const provider = await prepareOAuthRequest(
      input.config.compact.upstream_mode === "primary" ? input.config.primary : input.config.compact,
      input.oauth, plan, "POST", { req: input.req, res: input.res, startedAt,
        timeoutMs: Math.min(plan.timeoutMs, MAX_PROBE_TIMEOUT_MS), timeoutMessage: plan.timeoutMessage }
    );
    if (input.res.destroyed) throw new ConfigError("Client disconnected during OAuth preparation.", 499);
    plan.requestHeaders["accept-encoding"] = "identity";
    const source = await sendBufferedUpstreamRequest({
      req: input.req,
      res: input.res,
      upstream: plan.upstream,
      startedAt,
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
    const result = provider === "openai-codex" && probeTransportFailure(source) === null
      ? await normalizeCodexProbeResult(source)
      : source;
    const compactionItemCount = countProbeCompactionItems(
      protocol,
      result.responseBody,
      result.responseHeaders
    );
    const usage = extractResponseUsage(result.responseBody, result.responseHeaders);
    const failureReason = probeFailureReason({
      protocol,
      result,
      compactionItemCount,
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

async function normalizeCodexProbeResult(result: BufferedUpstreamResult): Promise<BufferedUpstreamResult> {
  try {
    const adapter = createCodexResponseTransform(result.status, result.responseHeaders, true);
    if (!adapter) return result;
    const observer = createOpenAiStreamObserver(adapter.responseHeaders, { maxEventBytes: MAX_PROBE_RESPONSE_BYTES });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let bufferedBytes = 0;
    await pipeline(Readable.from([result.responseBody]), adapter.stream, async source => {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        bufferedBytes = appendBufferedResponseChunk(chunks, bufferedBytes, buffer, MAX_PROBE_RESPONSE_BYTES);
        observer?.observe(buffer);
      }
    });
    return {
      ...result,
      responseBody: Buffer.concat(chunks, bufferedBytes),
      responseBodyBytes: bytes,
      responseBodyTruncated: bytes > bufferedBytes,
      responseHeaders: adapter.responseHeaders,
      streamSummary: await observer?.finish() ?? null,
      errorSummary: adapter.translationError ?? null
    };
  } catch (error) {
    return { ...result, errorSummary: summaryForError(error) };
  }
}

function probeTransportFailure(result: BufferedUpstreamResult): string | null {
  const summary = result.streamSummary;
  if (result.status < 200 || result.status >= 300) {
    return result.errorSummary ?? `Upstream returned HTTP ${result.status}.`;
  }
  if (result.responseBodyTruncated) {
    return `Capability probe response exceeded ${MAX_PROBE_RESPONSE_BYTES} bytes.`;
  }
  const responseError = result.errorSummary ?? summary?.errorSummary;
  if (responseError) return responseError;
  if (summary?.decodeError) return "Capability probe response could not be decoded.";
  if (summary?.sawFailedEvent || summary?.sawIncompleteEvent) {
    return `Capability probe ended with ${summary.sawFailedEvent ? "response.failed" : "response.incomplete"}.`;
  }
  return null;
}

function probeFailureReason(input: {
  protocol: UpstreamProtocol;
  result: BufferedUpstreamResult;
  compactionItemCount: number;
}): string | null {
  const { result } = input;
  const transportFailure = probeTransportFailure(result);
  if (transportFailure) return transportFailure;
  const summary = result.streamSummary;
  const terminalEvent = summary?.terminalEvent ?? null;
  const sse = isSseResponse(result.responseHeaders);
  if (!sse) {
    const parsed = parseJsonRecord(Buffer.from(decodeResponseText(result.responseBody, result.responseHeaders) ?? ""));
    if (parsed?.error != null || parsed?.status === "failed" || parsed?.status === "incomplete") {
      return `Capability probe ended with ${parsed.status === "incomplete" ? "response.incomplete" : "response.failed"}.`;
    }
  }
  if (input.compactionItemCount === 0) {
    return "Capability probe response did not include a compaction item.";
  }
  if (sse && !summary?.sawTerminalEvent) {
    return "Capability probe stream ended without a terminal event.";
  }
  if (
    sse &&
    input.protocol === "openai_responses" &&
    terminalEvent !== "response.completed" &&
    terminalEvent !== "[DONE]"
  ) {
    return `Capability probe ended with ${terminalEvent ?? "an unknown event"}.`;
  }
  if (sse && input.protocol === "anthropic_messages" && terminalEvent !== "message_stop") {
    return `Capability probe ended with ${terminalEvent ?? "an unknown event"}.`;
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

  const text = decodeResponseText(body, headers);
  if (text === null) return 0;
  const parsed = parseJsonRecord(Buffer.from(text));
  if (parsed) {
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    return content.filter((item) => isRecord(item) && item.type === "compaction").length;
  }

  let count = 0;
  for (const data of sseDataFrames(text)) {
    try {
      const event = JSON.parse(data) as unknown;
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
