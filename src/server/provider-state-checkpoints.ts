import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../shared/records.js";
import type { UpstreamProtocol } from "../shared/types.js";
import { parseJsonRecord } from "./http-utils.js";
import { decodeResponseText } from "./usage-utils.js";
import { synthesizeAssistantMessage } from "./compaction-bridge.js";
import type { BufferedUpstreamResult } from "./upstream-client.js";
import { recoveryHash, type ProviderStateRecoveryStore } from "./provider-state-recovery-store.js";
import { hasEncryptedProviderState, lowerFidelity, type ProviderStateFidelity } from "./provider-state-portability.js";
import { sseDataFrames } from "./sse-frames.js";
import { stripResponsesInputItemIds } from "./host-quirks.js";

export function recoveryPlanKey(scope: string, body: Buffer): string {
  const parsed = parseJsonRecord(body);
  const state = Array.isArray(parsed?.input) ? parsed.input.filter(item => isRecord(item) &&
    (hasEncryptedProviderState(item) || ["reasoning", "agent_message", "compaction", "item_reference"].includes(String(item.type)))) : [];
  return recoveryHash(scope, JSON.stringify([state, parsed?.previous_response_id, parsed?.previousResponseId]));
}

export function restoreProviderCheckpoint(
  store: ProviderStateRecoveryStore, conversationHash: string, body: Buffer, retentionHours: number
): { body: Buffer; fidelity: ProviderStateFidelity } | null {
  const parsed = parseJsonRecord(body);
  if (!parsed) return null;
  const previous = parsed.previous_response_id ?? parsed.previousResponseId;
  if (typeof previous === "string") {
    if (parsed.previous_response_id != null && parsed.previousResponseId != null && parsed.previous_response_id !== parsed.previousResponseId) return null;
    const checkpoint = store.findCheckpoint(recoveryHash(conversationHash, "response", previous), retentionHours);
    const tail = typeof parsed.input === "string" ? [{ type: "message", role: "user", content: parsed.input }]
      : Array.isArray(parsed.input) ? parsed.input : parsed.input === undefined ? [] : null;
    if (!checkpoint || !tail) return null;
    delete parsed.previous_response_id;
    delete parsed.previousResponseId;
    return { body: Buffer.from(JSON.stringify({ ...parsed, input: [...checkpoint.history, ...tail] })), fidelity: checkpoint.fidelity };
  }
  if (!Array.isArray(parsed.input)) return null;
  const inputItems = parsed.input;
  // A checkpoint covers a window, not one replaceable item: retained messages must not be duplicated.
  for (let index = parsed.input.length - 1; index >= 0; index--) {
    const item = parsed.input[index];
    if (!isRecord(item) || item.type !== "compaction" || typeof item.encrypted_content !== "string") continue;
    const checkpoint = store.findCheckpoint(recoveryHash(conversationHash, item.encrypted_content), retentionHours);
    if (!checkpoint) return null;
    let tailStart: number;
    if (checkpoint.prefixHash !== null) {
      if (index !== 0 && recoveryHash(JSON.stringify(parsed.input.slice(0, index))) !== checkpoint.prefixHash) return null;
      if (!sameCompaction(item, checkpoint.window[0])) return null;
      tailStart = index + 1;
    } else {
      // Compare against the same stateless replay cleanup, including reference guards in the tail.
      const normalized = parseJsonRecord(stripResponsesInputItemIds(Buffer.from(JSON.stringify({
        ...parsed, input: [...checkpoint.window, ...inputItems.slice(checkpoint.window.length)]
      }))))?.input;
      if (parsed.input.length < checkpoint.window.length ||
        !checkpoint.window.every((expected, i) => sameWindowItem(inputItems[i], expected) ||
          Array.isArray(normalized) && sameWindowItem(inputItems[i], normalized[i]))) return null;
      tailStart = checkpoint.window.length;
    }
    return { body: Buffer.from(JSON.stringify({ ...parsed, input: [...checkpoint.history, ...parsed.input.slice(tailStart)] })), fidelity: checkpoint.fidelity };
  }
  return null;
}

export function rememberProviderCheckpoint(input: {
  store: ProviderStateRecoveryStore;
  checkpointGeneration: number | null;
  conversationHash: string | null;
  retentionHours: number;
  requestBody: Buffer;
  requestFidelity?: ProviderStateFidelity;
  result: BufferedUpstreamResult;
  mode: "remote_v1" | "remote_v2";
  upstreamProtocol?: UpstreamProtocol;
}): boolean {
  if (input.retentionHours === 0 || !input.conversationHash || input.checkpointGeneration === null ||
    input.checkpointGeneration !== input.store.checkpointGeneration) return false;
  try {
    let result = input.result;
    const translated = input.upstreamProtocol !== undefined && input.upstreamProtocol !== "openai_responses";
    if (translated && !result.clientResponseHeaders) return false;
    const sourceSummary = result.streamSummary;
    if (sourceSummary && (sourceSummary.decodeError || sourceSummary.sawFailedEvent || sourceSummary.sawIncompleteEvent ||
      sourceSummary.oversizedEventCount > 0 || sourceSummary.errorSummary)) return false;
    if (result.clientResponseHeaders) {
      if (!result.clientResponseBody || result.clientResponseBodyTruncated !== false) return false;
      // Adapters own terminal normalization; retain source failure/truncation guards.
      result = { ...result, responseBody: result.clientResponseBody, responseHeaders: result.clientResponseHeaders,
        streamSummary: result.clientStreamSummary ?? null };
    }
    const output = completedResponseOutput(result);
    if (!output) return false;
    // JSON adaptation can hide missing/contradictory SSE items; validate the source window too.
    if (!translated && input.result.clientResponseHeaders && !isDeepStrictEqual(output, completedResponseOutput(input.result, true))) return false;
    let compactionIndex = -1;
    output.forEach((item, index) => { if (isRecord(item) && item.type === "compaction") compactionIndex = index; });
    const compaction = output[compactionIndex];
    const restored = restoreProviderCheckpoint(input.store, input.conversationHash, input.requestBody, input.retentionHours);
    const requestFidelity = lowerFidelity(input.requestFidelity ?? "exact", restored?.fidelity ?? "exact");
    const request = parseJsonRecord(restored?.body ?? input.requestBody);
    if (!request || request.previous_response_id != null || request.previousResponseId != null) return false;
    const history = typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }]
      : Array.isArray(request.input) ? request.input : null;
    if (!history) return false;
    const prefix = input.mode === "remote_v2" && compactionIndex >= 0 ? [...history, ...output.slice(0, compactionIndex)] : history;
    const portable = portableHistory(prefix);
    if (!portable) return false;
    const observedInput = parseJsonRecord(input.requestBody)?.input;
    const observedHistory = typeof observedInput === "string" ? [{ type: "message", role: "user", content: observedInput }]
      : Array.isArray(observedInput) ? observedInput : [];
    let saved = false;
    if (isRecord(compaction) && typeof compaction.encrypted_content === "string") saved = input.store.rememberCheckpoint(recoveryHash(input.conversationHash, compaction.encrypted_content), {
      window: input.mode === "remote_v1" ? output : [compaction],
      history: portable.items,
      fidelity: lowerFidelity(requestFidelity, portable.fidelity),
      prefixHash: input.mode === "remote_v2" ? recoveryHash(JSON.stringify([...observedHistory, ...output.slice(0, compactionIndex)])) : null
    }, input.retentionHours);
    if (input.mode === "remote_v2") {
      const responseId = result.streamSummary?.responseId ?? parseJsonRecord(Buffer.from(decodeResponseText(result.responseBody, result.responseHeaders) ?? ""))?.id;
      const completeHistory = portableHistory([...history, ...output.filter(item => !isRecord(item) || item.type !== "compaction")]);
      if (typeof responseId === "string" && completeHistory) saved = input.store.rememberCheckpoint(
        recoveryHash(input.conversationHash, "response", responseId), {
          window: [], history: completeHistory.items, prefixHash: null,
          fidelity: lowerFidelity(requestFidelity, completeHistory.fidelity)
        }, input.retentionHours
      ) || saved;
    }
    return saved;
  } catch (error) {
    return input.store.reportWriteFailure(error);
  }
}

export function completedResponseOutput(result: BufferedUpstreamResult, allowDoneEvent = false): unknown[] | null {
  if (result.status < 200 || result.status >= 300 || result.errorSummary || result.responseBodyTruncated ||
    result.clientDisconnectPhase === "before_terminal") return null;
  const text = decodeResponseText(result.responseBody, result.responseHeaders);
  if (text === null) return null;
  if (!String(result.responseHeaders["content-type"]).includes("text/event-stream")) {
    const parsed = parseJsonRecord(Buffer.from(text));
    return parsed && !parsed.error && (parsed.status == null || parsed.status === "completed") && Array.isArray(parsed.output) ? parsed.output : null;
  }
  if (!result.streamSummary || !result.streamSummary.sawCompletedEvent && !allowDoneEvent || result.streamSummary.decodeError ||
    result.streamSummary.sawFailedEvent || result.streamSummary.sawIncompleteEvent || result.streamSummary.oversizedEventCount > 0) return null;
  const items = new Map<number, unknown>();
  const added = new Set<number>();
  let completed = false;
  let completedOutput: unknown[] | null = null;
  for (const data of sseDataFrames(text)) {
    const event = parseJsonRecord(Buffer.from(data));
    if (!event) return null;
    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") return null;
    if (event.type === "response.output_item.added") {
      if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0) return null;
      added.add(Number(event.output_index));
    }
    if (event.type === "response.output_item.done") {
      if (!Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0 || !isRecord(event.item)) return null;
      const index = Number(event.output_index);
      if (items.has(index) && !isDeepStrictEqual(items.get(index), event.item)) return null;
      items.set(index, event.item);
    }
    if (event.type === "response.completed" || allowDoneEvent && event.type === "response.done") {
      if (isRecord(event.response) && (event.response.error != null ||
        event.response.status != null && event.response.status !== "completed")) return null;
      completed = true;
      if (isRecord(event.response) && Array.isArray(event.response.output)) completedOutput = event.response.output;
    }
  }
  // Codex may leave terminal output empty and provide the full items in done events.
  if (allowDoneEvent && completedOutput?.length === 0 && items.size > 0) completedOutput = null;
  if (completedOutput) {
    const output = completedOutput;
    return [...added].every(index => index < output.length) && [...items].every(([index, item]) => isDeepStrictEqual(output[index], item)) ? output : null;
  }
  const ordered = [...items.entries()].sort(([left], [right]) => left - right);
  return completed && ordered.length > 0 && [...added].every(index => items.has(index)) && ordered.every(([index], i) => index === i)
    ? ordered.map(([, item]) => item) : null;
}

function portableHistory(history: unknown[]): { items: unknown[]; fidelity: ProviderStateFidelity } | null {
  const items: unknown[] = [];
  let fidelity: ProviderStateFidelity = "exact";
  for (const original of history) {
    if (!isRecord(original)) return null;
    if (original.type === "compaction_trigger") continue;
    if (original.type === "reasoning") { fidelity = "degraded"; continue; }
    if (original.type === "compaction") {
      const summary = typeof original.encrypted_content === "string" ? synthesizeAssistantMessage(original.encrypted_content) : null;
      if (!summary) return null;
      items.push(summary);
      if (fidelity === "exact") fidelity = "summary";
      continue;
    }
    if (original.type === "item_reference" || original.type === undefined && typeof original.id === "string") return null;
    const item = { ...original };
    if (item.type === "agent_message" && Array.isArray(item.content)) {
      const content = item.content.filter(block => !isRecord(block) || block.type !== "encrypted_content");
      if (content.length !== item.content.length) {
        if (!content.some(block => isRecord(block) && block.type === "input_text" && typeof block.text === "string" && block.text.trim())) return null;
        item.content = content;
        fidelity = "degraded";
      }
    }
    if (Object.hasOwn(item, "encrypted_content")) return null;
    if (["message", "function_call", "custom_tool_call"].includes(String(item.type))) delete item.id;
    for (const key of Object.keys(item)) if (key === "_passthrough" || key.startsWith("internal_")) delete item[key];
    items.push(item);
  }
  return { items, fidelity };
}

function sameCompaction(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right) && left.type === "compaction" && right.type === "compaction" && left.encrypted_content === right.encrypted_content;
}

function sameWindowItem(left: unknown, right: unknown): boolean {
  return isRecord(right) && right.type === "compaction" ? sameCompaction(left, right) : isDeepStrictEqual(left, right);
}
