import { Duplex, Transform, type TransformCallback } from "node:stream";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { IncomingHttpHeaders } from "node:http";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress
} from "node:zlib";
import {
  anthropicErrorToOpenAi,
  anthropicMessageToResponses,
  anthropicMessageToResponsesCompaction,
  anthropicUsageToResponses,
  chatCompletionToAnthropic,
  chatCompletionToResponses,
  chatCompletionToResponsesCompaction,
  chatUsageToResponses,
  encodeCompactGateCompactionSummary,
  encodeCompactGateState,
  openAiErrorToAnthropic,
  openAiInputTokensToAnthropic,
  openAiReasoningToAnthropic,
  openAiResponseToAnthropic,
  openAiStopReason,
  openAiUsageToAnthropic,
  ProtocolConversionError
} from "./protocol-conversion.js";
import { isRecord, parseJsonRecord } from "./http-utils.js";
import type { UpstreamResponseTransform } from "./upstream-client.js";

interface StreamBlock {
  itemId: string;
  outputIndex: number;
  type: "text" | "thinking" | "tool_use";
  callId?: string;
  name?: string;
  arguments: string;
  text: string;
  signature: string;
}

interface AnthropicStreamBlock {
  blockIndex: number;
  outputIndex: number;
  contentIndex: number;
  type: "text" | "tool_use" | "reasoning";
  started: boolean;
  stopped: boolean;
  text: string;
  arguments: string;
  callId?: string;
  name?: string;
  customTool?: boolean;
  inputEmitted?: boolean;
}

interface ChatStreamToolCall {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  emittedArgumentsLength: number;
  started: boolean;
  done: boolean;
}

export function createAnthropicToResponsesStream(): Transform {
  let responseId = `resp_${randomUUID()}`;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let inputTokenDetails: Record<string, unknown> | null = null;
  let nextOutputIndex = 0;
  let completed = false;
  let stopReason: string | null = null;
  const emit = createSequencedEmitter();
  const blocks = new Map<number, StreamBlock>();
  const outputItems: unknown[] = [];

  return createSseTransform({
    onData: convertFrame,
    onFlush(transform) {
      if (!completed) {
        emit(transform, "response.failed", {
          type: "response.failed",
          response: responseEnvelope("failed", {
            error: { message: "Anthropic stream closed before message_stop.", type: "upstream_stream_incomplete" }
          })
        });
      }
    }
  });

  function convertFrame(data: string, transform: Transform): void {
    const event = readSseEventRecord(data);
    if (!event || typeof event.type !== "string") {
      return;
    }

    if (event.type === "message_start" && isRecord(event.message)) {
      responseId = typeof event.message.id === "string" ? event.message.id : responseId;
      model = typeof event.message.model === "string" ? event.message.model : model;
      const usage = anthropicUsageToResponses(event.message.usage);
      inputTokens = usage && typeof usage.input_tokens === "number" ? usage.input_tokens : inputTokens;
      outputTokens = usage && typeof usage.output_tokens === "number" ? usage.output_tokens : outputTokens;
      inputTokenDetails = isRecord(usage?.input_tokens_details) ? usage.input_tokens_details : inputTokenDetails;
      emit(transform, "response.created", {
        type: "response.created",
        response: responseEnvelope("in_progress")
      });
      return;
    }

    if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
      const block = event.content_block;
      if (block.type === "text") {
        const state: StreamBlock = {
          itemId: `msg_${randomUUID()}`,
          outputIndex: nextOutputIndex++,
          type: "text",
          arguments: "",
          text: typeof block.text === "string" ? block.text : "",
          signature: ""
        };
        blocks.set(event.index, state);
        emit(transform, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: state.outputIndex,
          item: {
            id: state.itemId,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [{ type: "output_text", text: state.text, annotations: [] }]
          }
        });
        emit(transform, "response.content_part.added", {
          type: "response.content_part.added",
          item_id: state.itemId,
          output_index: state.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] }
        });
        if (state.text) {
          emit(transform, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: state.itemId,
            output_index: state.outputIndex,
            content_index: 0,
            delta: state.text
          });
        }
      } else if (block.type === "thinking") {
        const state: StreamBlock = {
          itemId: `rs_${randomUUID()}`,
          outputIndex: nextOutputIndex++,
          type: "thinking",
          arguments: "",
          text: typeof block.thinking === "string" ? block.thinking : "",
          signature: typeof block.signature === "string" ? block.signature : ""
        };
        blocks.set(event.index, state);
        emit(transform, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: state.outputIndex,
          item: { id: state.itemId, type: "reasoning", summary: [] }
        });
        emit(transform, "response.reasoning_summary_part.added", {
          type: "response.reasoning_summary_part.added",
          item_id: state.itemId,
          output_index: state.outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" }
        });
      } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const state: StreamBlock = {
          itemId: `fc_${randomUUID()}`,
          outputIndex: nextOutputIndex++,
          type: "tool_use",
          callId: block.id,
          name: block.name,
          arguments: isRecord(block.input) && Object.keys(block.input).length > 0
            ? JSON.stringify(block.input)
            : "",
          text: "",
          signature: ""
        };
        blocks.set(event.index, state);
        emit(transform, "response.output_item.added", {
          type: "response.output_item.added",
          output_index: state.outputIndex,
          item: {
            id: state.itemId,
            type: "function_call",
            status: "in_progress",
            call_id: state.callId,
            name: state.name,
            arguments: ""
          }
        });
      }
      return;
    }

    if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
      const state = blocks.get(event.index);
      if (!state) {
        return;
      }
      if (state.type === "text" && event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        state.text += event.delta.text;
        emit(transform, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: state.itemId,
          output_index: state.outputIndex,
          content_index: 0,
          delta: event.delta.text
        });
      } else if (
        state.type === "thinking" &&
        event.delta.type === "thinking_delta" &&
        typeof event.delta.thinking === "string"
      ) {
        state.text += event.delta.thinking;
        emit(transform, "response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: state.itemId,
          output_index: state.outputIndex,
          summary_index: 0,
          delta: event.delta.thinking
        });
      } else if (
        state.type === "thinking" &&
        event.delta.type === "signature_delta" &&
        typeof event.delta.signature === "string"
      ) {
        state.signature += event.delta.signature;
      } else if (
        state.type === "tool_use" &&
        event.delta.type === "input_json_delta" &&
        typeof event.delta.partial_json === "string"
      ) {
        state.arguments += event.delta.partial_json;
        emit(transform, "response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: event.delta.partial_json
        });
      }
      return;
    }

    if (event.type === "content_block_stop" && typeof event.index === "number") {
      const state = blocks.get(event.index);
      if (!state) {
        return;
      }
      if (state.type === "text") {
        emit(transform, "response.output_text.done", {
          type: "response.output_text.done",
          item_id: state.itemId,
          output_index: state.outputIndex,
          content_index: 0,
          text: state.text
        });
        const item = {
          id: state.itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: state.text, annotations: [] }]
        };
        outputItems[state.outputIndex] = item;
        emit(transform, "response.content_part.done", {
          type: "response.content_part.done",
          item_id: state.itemId,
          output_index: state.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: state.text, annotations: [] }
        });
        emit(transform, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item
        });
      } else if (state.type === "thinking") {
        const item = {
          id: state.itemId,
          type: "reasoning",
          summary: state.text ? [{ type: "summary_text", text: state.text }] : [],
          encrypted_content: encodeCompactGateState({
            kind: "anthropic_thinking",
            thinking: state.text,
            signature: state.signature
          })
        };
        outputItems[state.outputIndex] = item;
        emit(transform, "response.reasoning_summary_text.done", {
          type: "response.reasoning_summary_text.done",
          item_id: state.itemId,
          output_index: state.outputIndex,
          summary_index: 0,
          text: state.text
        });
        emit(transform, "response.reasoning_summary_part.done", {
          type: "response.reasoning_summary_part.done",
          item_id: state.itemId,
          output_index: state.outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: state.text }
        });
        emit(transform, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item
        });
      } else {
        const item = {
          id: state.itemId,
          type: "function_call",
          status: "completed",
          call_id: state.callId,
          name: state.name,
          arguments: state.arguments || "{}"
        };
        outputItems[state.outputIndex] = item;
        emit(transform, "response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: state.itemId,
          output_index: state.outputIndex,
          arguments: state.arguments || "{}"
        });
        emit(transform, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item
        });
      }
      blocks.delete(event.index);
      return;
    }

    if (event.type === "message_delta") {
      if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") {
        stopReason = event.delta.stop_reason;
      }
      const usage = anthropicUsageToResponses(event.usage);
      // Cumulative here too, so the same "only when it grew" rule the input
      // total uses below applies. Some relays append a zero-filled `usage` to
      // every frame after the real one — the behaviour `mergeUsage` already
      // guards against — and taking the last word wiped the output count the
      // preceding delta had just reported, in the very frame both the client
      // and the log read.
      if (usage && typeof usage.output_tokens === "number" && usage.output_tokens > outputTokens) {
        outputTokens = usage.output_tokens;
      }
      // Anthropic restates the *cumulative* counts here, and reports the cache split
      // in this frame when it is only settled at the end. Adopt the input total only
      // when it actually grew: the translated value is a derived sum, so a delta that
      // restates `input_tokens` without restating the cache split resolves to the
      // fresh part alone and would shrink message_start's correct total — producing a
      // usage where cached_tokens exceeds input_tokens, which the analytics layer then
      // reads as an additive dialect. Cumulative counters never decrease, so "grew" is
      // the right guard rather than "was present".
      if (typeof usage?.input_tokens === "number" && usage.input_tokens > inputTokens) {
        inputTokens = usage.input_tokens;
      }
      if (isRecord(usage?.input_tokens_details)) {
        inputTokenDetails = usage.input_tokens_details;
      }
      return;
    }

    if (event.type === "error") {
      completed = true;
      emit(transform, "response.failed", {
        type: "response.failed",
        response: responseEnvelope("failed", anthropicErrorToOpenAi(event, 502))
      });
      return;
    }

    if (event.type === "message_stop") {
      completed = true;
      const incomplete = stopReason === "max_tokens";
      emit(transform, incomplete ? "response.incomplete" : "response.completed", {
        type: incomplete ? "response.incomplete" : "response.completed",
        response: responseEnvelope(incomplete ? "incomplete" : "completed", incomplete
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {})
      });
    }
  }

  function responseEnvelope(
    status: "in_progress" | "completed" | "incomplete" | "failed",
    extra = {}
  ): Record<string, unknown> {
    return {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model,
      output: outputItems.filter((item) => item !== undefined),
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        // Rebuilding the usage from two scalars dropped `input_tokens_details`,
        // which is where the cache split lives. The non-streaming converter emits
        // it, so the same upstream reported a cache hit rate on the JSON path and
        // zero on the SSE path while the total matched — the analytics panel read
        // that as "no cache" rather than "unknown".
        ...(inputTokenDetails ? { input_tokens_details: inputTokenDetails } : {})
      },
      ...extra
    };
  }
}

export function createAnthropicToResponsesResponseTransform(
  status: number,
  headers: IncomingHttpHeaders
): UpstreamResponseTransform {
  ensureIdentityEncoding(headers);
  const responseHeaders = translatedHeaders(headers);
  const contentType = headerText(headers["content-type"]).toLowerCase();
  if (contentType.includes("text/event-stream")) {
    responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
    return {
      stream: createAnthropicToResponsesStream(),
      responseHeaders,
      streamProtocol: "openai"
    };
  }
  return bufferedJsonTransform(
    status,
    responseHeaders,
    (body) => anthropicMessageToResponses(body, status),
    "openai"
  );
}

export function createAnthropicToResponsesCompactionStream(): Transform {
  let responseId = `resp_${randomUUID()}`;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let summary: string | null = null;
  let outputItem: Record<string, unknown> | null = null;
  let completed = false;
  const emit = createSequencedEmitter();

  return createSseTransform({
    onData: convertFrame,
    onFlush(transform) {
      if (!completed) {
        completed = true;
        emit(transform, "response.failed", {
          type: "response.failed",
          response: responseEnvelope("failed", {
            error: {
              message: "Anthropic compaction stream closed before message_stop.",
              type: "upstream_stream_incomplete"
            }
          })
        });
      }
    }
  });

  function convertFrame(data: string, transform: Transform): void {
    const event = readSseEventRecord(data);
    if (!event || typeof event.type !== "string") {
      return;
    }

    if (event.type === "message_start" && isRecord(event.message)) {
      responseId = typeof event.message.id === "string" ? event.message.id : responseId;
      model = typeof event.message.model === "string" ? event.message.model : model;
      updateUsage(event.message.usage);
      emit(transform, "response.created", {
        type: "response.created",
        response: responseEnvelope("in_progress")
      });
      return;
    }

    if (
      event.type === "content_block_start" &&
      isRecord(event.content_block) &&
      event.content_block.type === "compaction"
    ) {
      if (typeof event.content_block.content === "string" && event.content_block.content.trim()) {
        summary = event.content_block.content;
      }
      return;
    }

    if (
      event.type === "content_block_delta" &&
      isRecord(event.delta) &&
      event.delta.type === "compaction_delta" &&
      typeof event.delta.content === "string" &&
      event.delta.content.length > 0
    ) {
      // Append verbatim: a delta carrying only whitespace still holds a word or
      // paragraph boundary, and trimming it away glues the summary together.
      summary = (summary ?? "") + event.delta.content;
      return;
    }

    if (event.type === "message_delta") {
      updateUsage(event.usage);
      return;
    }

    if (event.type === "error") {
      completed = true;
      emit(transform, "response.failed", {
        type: "response.failed",
        response: responseEnvelope("failed", anthropicErrorToOpenAi(event, 502))
      });
      return;
    }

    if (event.type !== "message_stop") {
      return;
    }

    completed = true;
    if (!summary) {
      emit(transform, "response.failed", {
        type: "response.failed",
        response: responseEnvelope("failed", {
          error: {
            message: "Anthropic compaction response did not include a readable compaction block.",
            type: "upstream_compaction_missing"
          }
        })
      });
      return;
    }

    outputItem = {
      type: "compaction",
      encrypted_content: encodeCompactGateCompactionSummary(summary)
    };
    emit(transform, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: outputItem
    });
    emit(transform, "response.completed", {
      type: "response.completed",
      response: responseEnvelope("completed")
    });
  }

  function updateUsage(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.input_tokens === "number" && Number.isInteger(value.input_tokens)) {
      inputTokens = value.input_tokens;
    }
    if (typeof value.output_tokens === "number" && Number.isInteger(value.output_tokens)) {
      outputTokens = value.output_tokens;
    }
  }

  function responseEnvelope(
    status: "in_progress" | "completed" | "failed",
    extra = {}
  ): Record<string, unknown> {
    return {
      id: responseId,
      object: "response.compaction",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model,
      output: outputItem ? [outputItem] : [],
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      },
      ...extra
    };
  }
}

export function createAnthropicToResponsesCompactionResponseTransform(
  status: number,
  headers: IncomingHttpHeaders
): UpstreamResponseTransform {
  ensureIdentityEncoding(headers);
  const responseHeaders = translatedHeaders(headers);
  const contentType = headerText(headers["content-type"]).toLowerCase();
  if (contentType.includes("text/event-stream")) {
    responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
    return {
      stream: createAnthropicToResponsesCompactionStream(),
      responseHeaders,
      streamProtocol: "openai"
    };
  }
  return bufferedJsonTransform(
    status,
    responseHeaders,
    (body) => anthropicMessageToResponsesCompaction(body, status),
    "openai"
  );
}

export function createResponsesToAnthropicStream(): Transform {
  const messageId = `msg_${randomUUID()}`;
  let model: string | null = null;
  let outputTokens = 0;
  let finalUsage: Record<string, unknown> | null = null;
  let messageStarted = false;
  let completed = false;
  let nextBlockIndex = 0;
  let sawToolUse = false;
  const blocks = new Map<string, AnthropicStreamBlock>();

  return createSseTransform({
    onData: convertFrame,
    onFlush(transform) {
      if (!completed) {
        completed = true;
        emit(transform, "error", {
          type: "error",
          error: {
            type: "api_error",
            message: "OpenAI stream closed before a terminal response event."
          }
        });
      }
    }
  });

  function convertFrame(data: string, transform: Transform): void {
    if (data === "[DONE]") {
      return;
    }
    const event = readSseEventRecord(data);
    if (!event || typeof event.type !== "string") {
      return;
    }

    if (event.type === "response.created" || event.type === "response.in_progress") {
      ensureMessageStart(transform, isRecord(event.response) ? event.response : null);
      return;
    }

    if (event.type === "response.output_item.added" && isRecord(event.item)) {
      const outputIndex = readIndex(event.output_index);
      if (event.item.type === "function_call") {
        ensureToolBlock(transform, outputIndex, event.item);
      } else if (event.item.type === "custom_tool_call") {
        ensureToolBlock(transform, outputIndex, event.item, true);
      } else if (event.item.type === "reasoning") {
        ensureBlock(outputIndex, -1, "reasoning");
      }
      return;
    }

    if (event.type === "response.content_part.added" && isRecord(event.part)) {
      if (event.part.type === "output_text") {
        const block = ensureTextBlock(transform, readIndex(event.output_index), readIndex(event.content_index));
        if (typeof event.part.text === "string" && event.part.text.length > 0) {
          emitTextDelta(transform, block, event.part.text);
        }
      }
      return;
    }

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      const block = ensureTextBlock(transform, readIndex(event.output_index), readIndex(event.content_index));
      emitTextDelta(transform, block, event.delta);
      return;
    }

    if (event.type === "response.output_text.done") {
      const block = ensureTextBlock(transform, readIndex(event.output_index), readIndex(event.content_index));
      if (block.text.length === 0 && typeof event.text === "string" && event.text.length > 0) {
        emitTextDelta(transform, block, event.text);
      }
      stopBlock(transform, block);
      return;
    }

    if (
      (event.type === "response.reasoning_summary_text.delta" ||
        event.type === "response.reasoning_text.delta" ||
        event.type === "response.reasoning.delta") &&
      typeof event.delta === "string"
    ) {
      const block = ensureReasoningBlock(transform, readIndex(event.output_index));
      block.text += event.delta;
      emit(transform, "content_block_delta", {
        type: "content_block_delta",
        index: block.blockIndex,
        delta: { type: "thinking_delta", thinking: event.delta }
      });
      return;
    }

    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const block = ensureToolBlock(transform, readIndex(event.output_index), event);
      block.arguments += event.delta;
      if (block.started) {
        emit(transform, "content_block_delta", {
          type: "content_block_delta",
          index: block.blockIndex,
          delta: { type: "input_json_delta", partial_json: event.delta }
        });
      }
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      const block = ensureToolBlock(transform, readIndex(event.output_index), event);
      if (block.arguments.length === 0 && typeof event.arguments === "string" && event.arguments.length > 0) {
        block.arguments = event.arguments;
        // Same guard as the `.delta` branch above. A block that never started
        // has no index yet, and emitting for it put `index: -1` on the wire:
        // an upstream that omits `output_index` on this frame resolves to slot
        // 0, which is a different, unstarted block whenever the real call sat
        // at a later output index.
        if (block.started) {
          emit(transform, "content_block_delta", {
            type: "content_block_delta",
            index: block.blockIndex,
            delta: { type: "input_json_delta", partial_json: event.arguments }
          });
        }
      }
      stopBlock(transform, block);
      return;
    }

    if (event.type === "response.custom_tool_call_input.delta" && typeof event.delta === "string") {
      // Accumulated but not forwarded: the fragments of a JSON string are not
      // themselves valid JSON, and a custom tool's freeform text has to be
      // wrapped into an object before it can go out as `input_json_delta`. The
      // whole input is emitted once the item closes.
      ensureToolBlock(transform, readIndex(event.output_index), event, true).arguments += event.delta;
      return;
    }

    if (event.type === "response.custom_tool_call_input.done") {
      const block = ensureToolBlock(transform, readIndex(event.output_index), event, true);
      if (typeof event.input === "string" && event.input.length > 0) {
        block.arguments = event.input;
      }
      emitToolInput(transform, block, block.arguments);
      stopBlock(transform, block);
      return;
    }

    if (event.type === "response.output_item.done" && isRecord(event.item)) {
      finishOutputItem(transform, readIndex(event.output_index), event.item);
      return;
    }

    if (event.type === "response.completed" || event.type === "response.incomplete") {
      finishMessage(transform, isRecord(event.response) ? event.response : {});
      return;
    }

    if (event.type === "response.failed") {
      completed = true;
      const source = isRecord(event.response) ? event.response : event;
      emit(transform, "error", openAiErrorToAnthropic(source, 502));
      return;
    }

    if (event.type === "error") {
      completed = true;
      emit(transform, "error", openAiErrorToAnthropic(event, 502));
    }
  }

  function ensureMessageStart(transform: Transform, response: Record<string, unknown> | null): void {
    updateResponse(response);
    if (messageStarted) {
      return;
    }
    messageStarted = true;
    const usage = openAiUsageToAnthropic(response?.usage);
    usage.output_tokens = 0;
    emit(transform, "message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage
      }
    });
  }

  function updateResponse(response: Record<string, unknown> | null): void {
    if (!response) {
      return;
    }
    if (typeof response.model === "string") {
      model = response.model;
    }
    if (isRecord(response.usage)) {
      // Keep the whole translated usage, not just the output count. Real upstreams
      // send `usage: null` on response.created and the real numbers only on
      // response.completed, so message_start's usage is always zeros and
      // message_delta is the one frame left that can carry input and cache counts.
      // Emitting output_tokens alone made every Claude-ingress stream over an
      // OpenAI upstream log inputTokens: 0 — claude-proxy prefers the usage
      // observed off the translated stream, so the numbers CompactGate reports
      // are the ones written here.
      finalUsage = openAiUsageToAnthropic(response.usage);
      if (typeof response.usage.output_tokens === "number") {
        outputTokens = response.usage.output_tokens;
      }
    }
  }

  function ensureBlock(
    outputIndex: number,
    contentIndex: number,
    type: AnthropicStreamBlock["type"]
  ): AnthropicStreamBlock {
    const key = `${outputIndex}:${contentIndex}:${type}`;
    const current = blocks.get(key);
    if (current) {
      return current;
    }
    const block: AnthropicStreamBlock = {
      // Assigned when the block actually starts, not here. Anthropic's `index` is
      // the block's position in the final `message.content` array, and a block
      // that never starts must not consume a position: a reasoning item with no
      // summary and no encrypted_content is dropped by
      // openAiReasoningToAnthropic, so allocating on creation burnt index 0 and
      // the following text block opened at index 1 with nothing at 0. Consumers
      // that assign by index get a hole; push-based accumulators only survive it
      // by ignoring the number.
      blockIndex: -1,
      outputIndex,
      contentIndex,
      type,
      started: false,
      stopped: false,
      text: "",
      arguments: ""
    };
    blocks.set(key, block);
    return block;
  }

  function startBlock(
    transform: Transform,
    block: AnthropicStreamBlock,
    contentBlock: Record<string, unknown>
  ): void {
    block.started = true;
    block.blockIndex = nextBlockIndex++;
    emit(transform, "content_block_start", {
      type: "content_block_start",
      index: block.blockIndex,
      content_block: contentBlock
    });
  }

  function ensureTextBlock(transform: Transform, outputIndex: number, contentIndex: number): AnthropicStreamBlock {
    const block = ensureBlock(outputIndex, contentIndex, "text");
    ensureMessageStart(transform, null);
    if (!block.started) {
      startBlock(transform, block, { type: "text", text: "" });
    }
    return block;
  }

  function emitTextDelta(transform: Transform, block: AnthropicStreamBlock, text: string): void {
    block.text += text;
    emit(transform, "content_block_delta", {
      type: "content_block_delta",
      index: block.blockIndex,
      delta: { type: "text_delta", text }
    });
  }

  function ensureToolBlock(
    transform: Transform,
    outputIndex: number,
    item: Record<string, unknown>,
    customTool = false
  ): AnthropicStreamBlock {
    const block = ensureBlock(outputIndex, -1, "tool_use");
    if (customTool) {
      block.customTool = true;
    }
    if (typeof item.call_id === "string") {
      block.callId = item.call_id;
    }
    if (typeof item.name === "string") {
      block.name = item.name;
    }
    if (!block.started && block.callId && block.name) {
      ensureMessageStart(transform, null);
      sawToolUse = true;
      startBlock(transform, block, {
        type: "tool_use",
        id: block.callId,
        name: block.name,
        input: {}
      });
    }
    return block;
  }

  function emitToolInput(transform: Transform, block: AnthropicStreamBlock, raw: string): void {
    if (!block.started || block.inputEmitted || raw.length === 0) {
      return;
    }
    block.inputEmitted = true;
    emit(transform, "content_block_delta", {
      type: "content_block_delta",
      index: block.blockIndex,
      delta: {
        type: "input_json_delta",
        // A custom tool carries freeform text where a function carries JSON, and
        // Anthropic's tool_use.input is always an object — so the text goes under
        // a single key, the same shape the request direction produces for the
        // matching input item.
        partial_json: block.customTool ? JSON.stringify({ input: raw }) : raw
      }
    });
  }

  function ensureReasoningBlock(transform: Transform, outputIndex: number): AnthropicStreamBlock {
    const block = ensureBlock(outputIndex, -1, "reasoning");
    ensureMessageStart(transform, null);
    if (!block.started) {
      startBlock(transform, block, { type: "thinking", thinking: "", signature: "" });
    }
    return block;
  }

  function finishOutputItem(
    transform: Transform,
    outputIndex: number,
    item: Record<string, unknown>
  ): void {
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
        const part = content[contentIndex];
        if (!isRecord(part) || (part.type !== "output_text" && part.type !== "refusal")) {
          continue;
        }
        const text = typeof part.text === "string"
          ? part.text
          : typeof part.refusal === "string"
            ? part.refusal
            : "";
        const block = ensureTextBlock(transform, outputIndex, contentIndex);
        if (block.text.length === 0 && text.length > 0) {
          emitTextDelta(transform, block, text);
        }
        stopBlock(transform, block);
      }
      return;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const customTool = item.type === "custom_tool_call";
      const block = ensureToolBlock(transform, outputIndex, item, customTool);
      if (!block.started) {
        throw new ProtocolConversionError("OpenAI tool call stream item was missing call_id or name.", 502);
      }
      // A custom tool names its payload `input`, a function names it `arguments`.
      // Refusing the item instead killed the whole stream, while the request
      // direction has always translated the matching input item.
      const raw = customTool ? item.input : item.arguments;
      if (block.arguments.length === 0 && typeof raw === "string" && raw.length > 0) {
        block.arguments = raw;
        emitToolInput(transform, block, raw);
      } else if (customTool) {
        // Its fragments were buffered rather than forwarded, so the input still
        // has to go out — once, whichever closing event arrives first.
        emitToolInput(transform, block, block.arguments);
      }
      stopBlock(transform, block);
      return;
    }
    if (item.type === "reasoning") {
      const anthropic = openAiReasoningToAnthropic(item);
      if (!anthropic) {
        return;
      }
      if (anthropic.type === "redacted_thinking") {
        ensureMessageStart(transform, null);
        const block = ensureBlock(outputIndex, -1, "reasoning");
        if (!block.started) {
          startBlock(transform, block, anthropic);
        }
        stopBlock(transform, block);
        return;
      }
      const block = ensureReasoningBlock(transform, outputIndex);
      const thinking = typeof anthropic.thinking === "string" ? anthropic.thinking : "";
      if (block.text.length === 0 && thinking.length > 0) {
        block.text = thinking;
        emit(transform, "content_block_delta", {
          type: "content_block_delta",
          index: block.blockIndex,
          delta: { type: "thinking_delta", thinking }
        });
      }
      if (typeof anthropic.signature === "string") {
        emit(transform, "content_block_delta", {
          type: "content_block_delta",
          index: block.blockIndex,
          delta: { type: "signature_delta", signature: anthropic.signature }
        });
      }
      stopBlock(transform, block);
      return;
    }
    throw new ProtocolConversionError(`Unsupported OpenAI stream output item type: ${String(item.type)}.`, 502);
  }

  function stopBlock(transform: Transform, block: AnthropicStreamBlock): void {
    if (!block.started || block.stopped) {
      return;
    }
    block.stopped = true;
    emit(transform, "content_block_stop", {
      type: "content_block_stop",
      index: block.blockIndex
    });
  }

  function finishMessage(transform: Transform, response: Record<string, unknown>): void {
    if (completed) {
      return;
    }
    updateResponse(response);
    ensureMessageStart(transform, response);
    const output = Array.isArray(response.output) ? response.output : [];
    for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
      if (isRecord(output[outputIndex])) {
        finishOutputItem(transform, outputIndex, output[outputIndex]);
      }
    }
    for (const block of blocks.values()) {
      stopBlock(transform, block);
    }
    // Truncation outranks the tool call. A response cut off at max_output_tokens
    // mid-arguments was reported as a complete `tool_use`, so the client executed
    // a half-serialized call instead of seeing that the turn ran out of room.
    const upstreamStopReason = openAiStopReason(response);
    const stopReason = upstreamStopReason === "max_tokens" || !sawToolUse
      ? upstreamStopReason
      : "tool_use";
    emit(transform, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { ...finalUsage, output_tokens: outputTokens }
    });
    emit(transform, "message_stop", { type: "message_stop" });
    completed = true;
  }

  function emit(transform: Transform, event: string, payload: unknown): void {
    transform.push(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

export function createResponsesToAnthropicResponseTransform(
  status: number,
  headers: IncomingHttpHeaders
): UpstreamResponseTransform {
  ensureIdentityEncoding(headers);
  const responseHeaders = translatedHeaders(headers);
  const contentType = headerText(headers["content-type"]).toLowerCase();
  if (contentType.includes("text/event-stream")) {
    responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
    return {
      stream: createResponsesToAnthropicStream(),
      responseHeaders,
      streamProtocol: "anthropic"
    };
  }
  return bufferedJsonTransform(
    status,
    responseHeaders,
    (body) => openAiResponseToAnthropic(body, status),
    "anthropic"
  );
}

export function createOpenAiInputTokensToAnthropicResponseTransform(
  status: number,
  headers: IncomingHttpHeaders
): UpstreamResponseTransform {
  ensureIdentityEncoding(headers);
  return bufferedJsonTransform(
    status,
    translatedHeaders(headers),
    (body) => openAiInputTokensToAnthropic(body, status),
    "anthropic"
  );
}

export function createChatToResponsesStream(): Transform {
  let responseId = `resp_${randomUUID()}`;
  let model: string | null = null;
  let createdAt = Math.floor(Date.now() / 1000);
  let completed = false;
  let created = false;
  let textStarted = false;
  let text = "";
  let textItemId: string | null = null;
  let nextOutputIndex = 0;
  let textOutputIndex: number | null = null;
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  const emit = createSequencedEmitter();
  const toolCalls = new Map<number, ChatStreamToolCall>();
  const toolCallSlotsById = new Map<string, number>();
  let lastToolCallSlot = 0;

  return createSseTransform({
    onData: convertFrame,
    onFlush(transform) {
      if (!completed) {
        if (finishReason !== null) {
          finish(transform);
        } else {
          fail(transform, "OpenAI Chat stream closed before a finish reason or [DONE] marker.");
        }
      }
    }
  });

  function convertFrame(data: string, transform: Transform): void {
    if (data === "[DONE]") {
      finish(transform);
      return;
    }
    const event = readSseEventRecord(data);
    if (!event) {
      return;
    }
    if (isRecord(event.error)) {
      fail(
        transform,
        typeof event.error.message === "string"
          ? event.error.message
          : "OpenAI Chat upstream returned a streaming error.",
        event.error
      );
      return;
    }
    responseId = typeof event.id === "string" ? event.id : responseId;
    model = typeof event.model === "string" ? event.model : model;
    createdAt = nonNegativeStreamInteger(event.created) ?? createdAt;
    ensureCreated(transform);
    usage = chatUsageToResponses(event.usage) ?? usage;

    const choices = Array.isArray(event.choices) ? event.choices : [];
    if (choices.length > 1) {
      throw new ProtocolConversionError("OpenAI Chat streams with multiple choices cannot be translated.", 502);
    }
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (!choice) {
      return;
    }
    if (nonNegativeStreamInteger(choice.index) !== 0) {
      throw new ProtocolConversionError("Only OpenAI Chat choice index 0 can be translated.", 502);
    }
    if (typeof choice.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }
    const delta = isRecord(choice.delta) ? choice.delta : null;
    if (!delta) {
      return;
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      startText(transform);
      text += delta.content;
      emit(transform, "response.output_text.delta", {
        type: "response.output_text.delta",
        // Present on every other emitter in this module and on the real Responses
        // API; a client that keys deltas by item_id saw undefined here.
        item_id: textItemId,
        output_index: textOutputIndex,
        content_index: 0,
        delta: delta.content
      });
    }
    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      throw new ProtocolConversionError("OpenAI Chat streaming refusals cannot be translated.", 502);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const item of delta.tool_calls) {
        if (!isRecord(item)) {
          throw new ProtocolConversionError("OpenAI Chat stream tool_calls must be objects.", 502);
        }
        // An upstream that omits `index` used to land every call on slot 0, merging
        // parallel calls into one whose name was the concatenation of all of theirs.
        // A frame carrying an id gets its own slot; a continuation frame carries
        // neither an index nor an id, so it continues the slot most recently
        // touched. Keying purely on the id would have been worse than the original:
        // the very upstreams that omit `index` also omit `id` after the first frame,
        // so every argument fragment fell back to slot 0 and conjured a second,
        // nameless call there — turning a working single call into a 502.
        const index = typeof item.id === "string" && item.id.length > 0
          ? toolCallSlotForId(item.id, nonNegativeStreamInteger(item.index))
          : nonNegativeStreamInteger(item.index) ?? lastToolCallSlot;
        lastToolCallSlot = index;
        const call = ensureToolCall(transform, index, item);
        if (item.type !== undefined && item.type !== "function") {
          throw new ProtocolConversionError("Only OpenAI Chat function tool calls can be translated.", 502);
        }
        const fn = isRecord(item.function) ? item.function : null;
        if (typeof fn?.name === "string" && fn.name.length > 0) {
          call.name = !call.name || call.name === fn.name ? fn.name : `${call.name}${fn.name}`;
        }
        if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
          call.arguments += fn.arguments;
        }
        startToolCallIfReady(transform, call);
        if (call.started && call.arguments.length > call.emittedArgumentsLength) {
          const delta = call.arguments.slice(call.emittedArgumentsLength);
          emit(transform, "response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            output_index: call.outputIndex,
            item_id: call.itemId,
            delta
          });
          call.emittedArgumentsLength = call.arguments.length;
        }
      }
    }
  }

  function ensureCreated(transform: Transform): void {
    if (created) {
      return;
    }
    created = true;
    emit(transform, "response.created", {
      type: "response.created",
      response: responseEnvelope("in_progress", [])
    });
  }

  function startText(transform: Transform): void {
    if (textStarted) {
      return;
    }
    textStarted = true;
    textOutputIndex = nextOutputIndex++;
    textItemId = `msg_${randomUUID()}`;
    emit(transform, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: textOutputIndex,
      item: { id: textItemId, type: "message", role: "assistant", status: "in_progress", content: [] }
    });
    emit(transform, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });
  }

  function toolCallSlotForId(callId: string, streamIndex: number | null): number {
    const existing = toolCallSlotsById.get(callId);
    if (existing !== undefined) {
      return existing;
    }
    // Bind the id to the index the upstream gave it, so the continuation frames
    // that carry the index but drop the id still land on this same call.
    if (streamIndex !== null && ![...toolCallSlotsById.values()].includes(streamIndex)) {
      toolCallSlotsById.set(callId, streamIndex);
      return streamIndex;
    }
    // Above any real index the same stream could also use, so an upstream that
    // mixes indexed and unindexed frames cannot have the two collide. Reached
    // either with no index at all, or with an index another id already owns —
    // an upstream that restarts `index` at 0 for its second call. Sharing that
    // slot concatenated both names into one call that matches no tool.
    const slot = 1_000 + toolCallSlotsById.size;
    toolCallSlotsById.set(callId, slot);
    return slot;
  }

  function ensureToolCall(
    transform: Transform,
    index: number,
    item: Record<string, unknown>
  ): ChatStreamToolCall {
    const existing = toolCalls.get(index);
    if (existing) {
      if (typeof item.id === "string" && item.id.length > 0) {
        existing.callId = item.id;
      }
      return existing;
    }
    const fn = isRecord(item.function) ? item.function : null;
    const call: ChatStreamToolCall = {
      outputIndex: nextOutputIndex++,
      itemId: `fc_${randomUUID()}`,
      callId: typeof item.id === "string" ? item.id : "",
      name: typeof fn?.name === "string" ? fn.name : "",
      arguments: "",
      emittedArgumentsLength: 0,
      started: false,
      done: false
    };
    toolCalls.set(index, call);
    startToolCallIfReady(transform, call);
    return call;
  }

  function startToolCallIfReady(transform: Transform, call: ChatStreamToolCall): void {
    if (call.started || !call.callId || !call.name) {
      return;
    }
    call.started = true;
    emit(transform, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: call.outputIndex,
      item: {
        id: call.itemId,
        type: "function_call",
        status: "in_progress",
        call_id: call.callId,
        name: call.name,
        arguments: ""
      }
    });
  }

  function finish(transform: Transform): void {
    if (completed) {
      return;
    }
    completed = true;
    ensureCreated(transform);
    const output: unknown[] = [];
    if (textStarted && textOutputIndex !== null) {
      emit(transform, "response.output_text.done", {
        type: "response.output_text.done",
        output_index: textOutputIndex,
        content_index: 0,
        text
      });
      emit(transform, "response.content_part.done", {
        type: "response.content_part.done",
        output_index: textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] }
      });
      const item = {
        id: textItemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }]
      };
      emit(transform, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: textOutputIndex,
        item
      });
      output[textOutputIndex] = item;
    }
    for (const call of toolCalls.values()) {
      startToolCallIfReady(transform, call);
      if (!call.started) {
        throw new ProtocolConversionError("OpenAI Chat stream tool call was missing an id or function name.", 502);
      }
      if (!call.done) {
        emit(transform, "response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          output_index: call.outputIndex,
          item_id: call.itemId,
          arguments: call.arguments
        });
        const item = {
          id: call.itemId,
          type: "function_call",
          status: "completed",
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments
        };
        emit(transform, "response.output_item.done", {
          type: "response.output_item.done",
          output_index: call.outputIndex,
          item
        });
        output[call.outputIndex] = item;
        call.done = true;
      }
    }
    const terminalReason = finishReason ?? "stop";
    const incomplete = terminalReason === "length" || terminalReason === "content_filter";
    emit(transform, incomplete ? "response.incomplete" : "response.completed", {
      type: incomplete ? "response.incomplete" : "response.completed",
      response: responseEnvelope(incomplete ? "incomplete" : "completed", output.filter(Boolean), incomplete
        ? { incomplete_details: { reason: terminalReason === "content_filter" ? "content_filter" : "max_output_tokens" } }
        : {})
    });
  }

  function fail(
    transform: Transform,
    message: string,
    source: Record<string, unknown> | null = null
  ): void {
    if (completed) {
      return;
    }
    completed = true;
    ensureCreated(transform);
    emit(transform, "response.failed", {
      type: "response.failed",
      response: {
        ...responseEnvelope("failed", []),
        error: source ?? { type: "upstream_stream_error", message }
      }
    });
  }

  function responseEnvelope(
    status: "in_progress" | "completed" | "incomplete" | "failed",
    output: unknown[],
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model,
      output,
      usage,
      ...extra
    };
  }
}

export function createChatToResponsesResponseTransform(
  status: number,
  headers: IncomingHttpHeaders
): UpstreamResponseTransform {
  ensureIdentityEncoding(headers);
  const responseHeaders = translatedHeaders(headers);
  const contentType = headerText(headers["content-type"]).toLowerCase();
  if (contentType.includes("text/event-stream")) {
    responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
    return {
      stream: createChatToResponsesStream(),
      responseHeaders,
      streamProtocol: "openai"
    };
  }
  return bufferedJsonTransform(
    status,
    responseHeaders,
    (body) => chatCompletionToResponses(body, status),
    "openai"
  );
}

export function createChatToResponsesCompactionResponseTransform(
  status: number,
  headers: IncomingHttpHeaders,
  stream: boolean
): UpstreamResponseTransform {
  ensureIdentityEncoding(headers);
  const responseHeaders = translatedHeaders(headers);
  responseHeaders["content-type"] = stream
    ? "text/event-stream; charset=utf-8"
    : "application/json; charset=utf-8";
  return bufferedJsonTransform(
    status,
    responseHeaders,
    (body) => {
      const compacted = chatCompletionToResponsesCompaction(body, status);
      return stream ? compactionJsonToSse(compacted) : compacted;
    },
    "openai"
  );
}

function compactionJsonToSse(body: Buffer): Buffer {
  const response = parseJsonRecord(body);
  if (!response || !Array.isArray(response.output)) {
    return body;
  }
  const outputItem = response.output[0];
  // Without an item to emit, JSON.stringify drops the key and the frame is a
  // structurally invalid output_item.done. Pass the body through untouched so
  // the caller sees a plain response instead of a fake compaction.
  if (!isRecord(outputItem) || outputItem.type !== "compaction") {
    return body;
  }
  const responseId = typeof response.id === "string" ? response.id : `resp_${randomUUID()}`;
  const created = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item: outputItem },
    { type: "response.completed", response }
  ];
  return Buffer.from(created.map((event) => {
    const payload = { ...event, sequence_number: created.indexOf(event) };
    return `event: ${payload.type}\ndata: ${JSON.stringify({ ...payload, id: responseId })}\n\n`;
  }).join(""));
}

export function createChatToAnthropicResponseTransform(
  status: number,
  headers: IncomingHttpHeaders
): UpstreamResponseTransform {
  ensureIdentityEncoding(headers);
  const responseHeaders = translatedHeaders(headers);
  const contentType = headerText(headers["content-type"]).toLowerCase();
  if (contentType.includes("text/event-stream")) {
    responseHeaders["content-type"] = "text/event-stream; charset=utf-8";
    return {
      stream: composeTransforms(
        createChatToResponsesStream(),
        createResponsesToAnthropicStream()
      ),
      responseHeaders,
      streamProtocol: "anthropic"
    };
  }
  return bufferedJsonTransform(
    status,
    responseHeaders,
    (body) => chatCompletionToAnthropic(body, status),
    "anthropic"
  );
}

/**
 * Terminator repair for an Anthropic upstream that is proxied verbatim.
 *
 * A relay that drops the connection mid-stream leaves the SSE without its
 * `content_block_stop`/`message_delta`/`message_stop`, and Claude Code discards
 * the whole assistant message when the terminator never arrives — the text it
 * already rendered disappears, so a truncated answer reads as no answer at all.
 * Bytes are forwarded unchanged; only an upstream that ends without
 * `message_stop` gets the open blocks closed and the terminator appended, so the
 * client keeps whatever did arrive.
 *
 * The repair is deliberately silent: nothing is injected into the text, because
 * an injected notice would become part of the assistant message and be replayed
 * to the model on the next turn. The truncation stays visible through the
 * upstream stream summary, which still reports `upstream_stream_incomplete`.
 */
export function createAnthropicPassthroughResponseTransform(
  _status: number,
  headers: IncomingHttpHeaders
): UpstreamResponseTransform | null {
  const contentType = headerText(headers["content-type"]).toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    // Non-stream bodies have no terminator to repair, so they stay byte-for-byte.
    return null;
  }
  const decompressor = responseDecompressor(headers);
  const repair = createAnthropicTerminatorRepairStream();
  const responseHeaders = { ...headers };
  delete responseHeaders["content-length"];
  if (decompressor) {
    // The appended terminator is plain text and a compressed body cannot be
    // extended by concatenating a second compressed member, so the stream is
    // decompressed here and forwarded uncompressed. The upstream request keeps
    // its original accept-encoding, so only the loopback hop loses compression.
    delete responseHeaders["content-encoding"];
  }
  return {
    stream: decompressor ? composeTransforms(decompressor, repair) : repair,
    responseHeaders,
    streamProtocol: "anthropic"
  };
}

function responseDecompressor(headers: IncomingHttpHeaders): Transform | null {
  const encoding = headerText(headers["content-encoding"]).trim().toLowerCase();
  if (encoding.includes("br")) {
    return createBrotliDecompress();
  }
  if (encoding.includes("gzip")) {
    return createGunzip();
  }
  if (encoding.includes("deflate")) {
    return createInflate();
  }
  if (encoding.includes("zstd")) {
    return createZstdDecompress();
  }
  return null;
}

function createAnthropicTerminatorRepairStream(): Transform {
  const decoder = new StringDecoder("utf8");
  const openBlocks = new Set<number>();
  let pending = "";
  let sawMessageStop = false;
  let sawMessageDelta = false;
  let usage: Record<string, unknown> | null = null;

  const observeFrame = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      return;
    }
    const event = readSseEventRecord(data);
    if (!event || typeof event.type !== "string") {
      return;
    }
    if (event.type === "content_block_start" && typeof event.index === "number") {
      openBlocks.add(event.index);
      return;
    }
    if (event.type === "content_block_stop" && typeof event.index === "number") {
      openBlocks.delete(event.index);
      return;
    }
    if (event.type === "message_start" && isRecord(event.message) && isRecord(event.message.usage)) {
      usage = event.message.usage;
      return;
    }
    if (event.type === "message_delta") {
      sawMessageDelta = true;
      if (isRecord(event.usage)) {
        usage = event.usage;
      }
      return;
    }
    if (event.type === "message_stop") {
      sawMessageStop = true;
    }
  };

  const observe = (text: string): void => {
    pending += text;
    while (true) {
      const match = pending.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        break;
      }
      observeFrame(pending.slice(0, match.index));
      pending = pending.slice(match.index + match[0].length);
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      observe(decoder.write(chunk));
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      observe(decoder.end());
      if (pending.trim()) {
        // A connection cut mid-frame leaves a trailing frame with no blank line.
        observeFrame(pending);
      }
      if (sawMessageStop) {
        callback();
        return;
      }
      let repaired = "";
      for (const index of [...openBlocks].sort((left, right) => left - right)) {
        repaired += sseFrame("content_block_stop", { type: "content_block_stop", index });
      }
      if (!sawMessageDelta) {
        repaired += sseFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          ...(usage ? { usage } : {})
        });
      }
      repaired += sseFrame("message_stop", { type: "message_stop" });
      callback(null, repaired);
    }
  });
}

function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Parses one SSE `data:` payload as a JSON object. A frame that is not valid
 * JSON is skipped rather than thrown: `JSON.parse` inside a converter rejects
 * the Transform, which destroys the whole stream, so one junk or truncated frame
 * used to cost the client the entire response instead of that one event.
 */
function readSseEventRecord(data: string): Record<string, unknown> | null {
  try {
    const event = JSON.parse(data) as unknown;
    return isRecord(event) ? event : null;
  } catch {
    return null;
  }
}

/**
 * Shared SSE reframing shell: decodes chunks, splits on blank-line frame
 * boundaries, joins each frame's `data:` lines, and hands non-empty payloads to
 * `onData`. `onFlush` runs after the final frame so converters can emit their
 * own stream-closed-early terminal event.
 */
function createSseTransform(options: {
  onData: (data: string, transform: Transform) => void;
  onFlush: (transform: Transform) => void;
}): Transform {
  let pending = "";
  const decoder = new StringDecoder("utf8");

  const convertFrame = (frame: string, transform: Transform): void => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      return;
    }
    options.onData(data, transform);
  };

  const flushFrames = (final: boolean, transform: Transform): void => {
    while (true) {
      const match = pending.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        break;
      }
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      convertFrame(frame, transform);
    }
    if (final && pending.trim()) {
      convertFrame(pending, transform);
      pending = "";
    }
  };

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      pending += decoder.write(chunk);
      try {
        flushFrames(false, this);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        pending += decoder.end();
        flushFrames(true, this);
        options.onFlush(this);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    }
  });
}

/** Responses-protocol emitter: stamps a monotonic `sequence_number` per event. */
function createSequencedEmitter(): (transform: Transform, event: string, payload: unknown) => void {
  let sequenceNumber = 0;
  return (transform, event, payload) => {
    const body = isRecord(payload) ? { ...payload, sequence_number: sequenceNumber++ } : payload;
    transform.push(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
  };
}

function bufferedJsonTransform(
  status: number,
  responseHeaders: IncomingHttpHeaders,
  convert: (body: Buffer) => Buffer,
  streamProtocol: "openai" | "anthropic"
): UpstreamResponseTransform {
  const chunks: Buffer[] = [];
  const transform: UpstreamResponseTransform = {
    stream: new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      flush(callback: TransformCallback) {
        const raw = Buffer.concat(chunks);
        try {
          this.push(convert(raw));
        } catch (error) {
          // The status line and headers are already on the wire by the time flush
          // runs, so failing the transform here destroyed the socket with zero
          // bytes written: the client saw a transport error ("fetch failed")
          // instead of the upstream's own message, and the log's error_summary
          // was overwritten with the converter's complaint. Every non-JSON error
          // body on a translated route took this path — an nginx HTML 502, a
          // plain-text gateway message, an empty body with a status code — which
          // is exactly when the operator most needs to see what the upstream said.
          this.push(untranslatableUpstreamBody(status, raw, responseHeaders, streamProtocol, error));
          // Reported out of band so the request is still recorded as a failure. A
          // 2xx whose body cannot be translated has nothing else marking it, and
          // failover reads a success as "this profile is healthy".
          transform.translationError = error instanceof Error
            ? `[compactgate] ${error.message}`
            : "[compactgate] Upstream response could not be translated.";
        }
        callback();
      }
    }),
    responseHeaders,
    streamProtocol
  };
  return transform;
}

/**
 * A last-resort body in the protocol the client is expecting, carrying whatever
 * the upstream actually sent. Framed as SSE when the response already announced
 * a stream, because a bare JSON object mid-stream is no more parseable to the
 * client than a dropped socket.
 */
function untranslatableUpstreamBody(
  status: number,
  raw: Buffer,
  responseHeaders: IncomingHttpHeaders,
  streamProtocol: "openai" | "anthropic",
  error: unknown
): Buffer {
  const detail = raw.toString("utf8").trim().replace(/\s+/g, " ").slice(0, 600);
  const reason = error instanceof Error ? error.message : "Upstream response could not be translated.";
  const message = `[compactgate] ${reason} Upstream returned HTTP ${status}${detail ? `: ${detail}` : " with an empty body"}`;
  const payload = streamProtocol === "anthropic"
    ? { type: "error", error: { type: "api_error", message } }
    : { error: { message, type: "upstream_error", code: null } };
  return headerText(responseHeaders["content-type"]).toLowerCase().includes("text/event-stream")
    ? Buffer.from(`event: error\ndata: ${JSON.stringify(payload)}\n\n`)
    : Buffer.from(JSON.stringify(payload));
}

function composeTransforms(first: Transform, second: Transform): Duplex {
  first.pipe(second);
  return Duplex.from({ writable: first, readable: second });
}

function ensureIdentityEncoding(headers: IncomingHttpHeaders): void {
  const contentEncoding = headerText(headers["content-encoding"]).trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new Error(`Translated upstream returned unsupported content-encoding: ${contentEncoding}.`);
  }
}

function readIndex(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function nonNegativeStreamInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function translatedHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const next = { ...headers };
  delete next["content-length"];
  delete next["content-encoding"];
  delete next.etag;
  next["content-type"] = "application/json; charset=utf-8";
  return next;
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : value ?? "";
}
