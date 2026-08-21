import { Duplex, Transform, type TransformCallback } from "node:stream";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { IncomingHttpHeaders } from "node:http";
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
    const event = JSON.parse(data) as unknown;
    if (!isRecord(event) || typeof event.type !== "string") {
      return;
    }

    if (event.type === "message_start" && isRecord(event.message)) {
      responseId = typeof event.message.id === "string" ? event.message.id : responseId;
      model = typeof event.message.model === "string" ? event.message.model : model;
      const usage = anthropicUsageToResponses(event.message.usage);
      inputTokens = usage && typeof usage.input_tokens === "number" ? usage.input_tokens : inputTokens;
      outputTokens = usage && typeof usage.output_tokens === "number" ? usage.output_tokens : outputTokens;
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
      if (usage && typeof usage.output_tokens === "number") {
        outputTokens = usage.output_tokens;
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
        total_tokens: inputTokens + outputTokens
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
    const event = JSON.parse(data) as unknown;
    if (!isRecord(event) || typeof event.type !== "string") {
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
    responseHeaders,
    (body) => anthropicMessageToResponsesCompaction(body, status),
    "openai"
  );
}

export function createResponsesToAnthropicStream(): Transform {
  const messageId = `msg_${randomUUID()}`;
  let model: string | null = null;
  let outputTokens = 0;
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
    const event = JSON.parse(data) as unknown;
    if (!isRecord(event) || typeof event.type !== "string") {
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
        emit(transform, "content_block_delta", {
          type: "content_block_delta",
          index: block.blockIndex,
          delta: { type: "input_json_delta", partial_json: event.arguments }
        });
      }
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
      blockIndex: nextBlockIndex++,
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

  function ensureTextBlock(transform: Transform, outputIndex: number, contentIndex: number): AnthropicStreamBlock {
    const block = ensureBlock(outputIndex, contentIndex, "text");
    ensureMessageStart(transform, null);
    if (!block.started) {
      block.started = true;
      emit(transform, "content_block_start", {
        type: "content_block_start",
        index: block.blockIndex,
        content_block: { type: "text", text: "" }
      });
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
    item: Record<string, unknown>
  ): AnthropicStreamBlock {
    const block = ensureBlock(outputIndex, -1, "tool_use");
    if (typeof item.call_id === "string") {
      block.callId = item.call_id;
    }
    if (typeof item.name === "string") {
      block.name = item.name;
    }
    if (!block.started && block.callId && block.name) {
      ensureMessageStart(transform, null);
      block.started = true;
      sawToolUse = true;
      emit(transform, "content_block_start", {
        type: "content_block_start",
        index: block.blockIndex,
        content_block: { type: "tool_use", id: block.callId, name: block.name, input: {} }
      });
    }
    return block;
  }

  function ensureReasoningBlock(transform: Transform, outputIndex: number): AnthropicStreamBlock {
    const block = ensureBlock(outputIndex, -1, "reasoning");
    ensureMessageStart(transform, null);
    if (!block.started) {
      block.started = true;
      emit(transform, "content_block_start", {
        type: "content_block_start",
        index: block.blockIndex,
        content_block: { type: "thinking", thinking: "", signature: "" }
      });
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
    if (item.type === "function_call") {
      const block = ensureToolBlock(transform, outputIndex, item);
      if (!block.started) {
        throw new ProtocolConversionError("OpenAI function call stream item was missing call_id or name.", 502);
      }
      if (block.arguments.length === 0 && typeof item.arguments === "string" && item.arguments.length > 0) {
        block.arguments = item.arguments;
        emit(transform, "content_block_delta", {
          type: "content_block_delta",
          index: block.blockIndex,
          delta: { type: "input_json_delta", partial_json: item.arguments }
        });
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
          block.started = true;
          emit(transform, "content_block_start", {
            type: "content_block_start",
            index: block.blockIndex,
            content_block: anthropic
          });
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
    const stopReason = sawToolUse ? "tool_use" : openAiStopReason(response);
    emit(transform, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens }
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
    const event = JSON.parse(data) as unknown;
    if (!isRecord(event)) {
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
        const index = nonNegativeStreamInteger(item.index) ?? 0;
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
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });
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
    responseHeaders,
    (body) => chatCompletionToAnthropic(body, status),
    "anthropic"
  );
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
  responseHeaders: IncomingHttpHeaders,
  convert: (body: Buffer) => Buffer,
  streamProtocol: "openai" | "anthropic"
): UpstreamResponseTransform {
  const chunks: Buffer[] = [];
  return {
    stream: new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      flush(callback: TransformCallback) {
        try {
          this.push(convert(Buffer.concat(chunks)));
          callback();
        } catch (error) {
          callback(error as Error);
        }
      }
    }),
    responseHeaders,
    streamProtocol
  };
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
