import { randomUUID } from "node:crypto";
import { isRecord, parseJsonRecord } from "./http-utils.js";

export class ProtocolConversionError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "ProtocolConversionError";
  }
}

const COMPACT_GATE_STATE_PREFIX = "cg1_";
const MAX_COMPACT_GATE_STATE_BYTES = 1024 * 1024;
const ANTHROPIC_COMPACTION_TRIGGER_TOKENS = 50_000;

export function encodeCompactGateState(value: Record<string, unknown>): string {
  return `${COMPACT_GATE_STATE_PREFIX}${Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url")}`;
}

export function decodeCompactGateState(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.startsWith(COMPACT_GATE_STATE_PREFIX)) {
    return null;
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value.slice(COMPACT_GATE_STATE_PREFIX.length), "base64url");
  } catch {
    return null;
  }
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_COMPACT_GATE_STATE_BYTES) {
    return null;
  }
  try {
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    return isRecord(parsed) && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function responsesRequestToAnthropic(rawBody: Buffer): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Responses request body must be a JSON object.", 400);
  }
  return responsesRecordToAnthropic(body, hasCompactionTrigger(body.input));
}

export function responsesCompactRequestToAnthropic(rawBody: Buffer): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Compact request body must be a JSON object.", 400);
  }
  return responsesRecordToAnthropic(body, true);
}

function responsesRecordToAnthropic(
  body: Record<string, unknown>,
  compaction: boolean
): Buffer {
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    throw new ProtocolConversionError("Responses request requires a string model.", 400);
  }
  if (Object.hasOwn(body, "previous_response_id") || Object.hasOwn(body, "previousResponseId")) {
    throw new ProtocolConversionError(
      "previous_response_id cannot be translated without the provider-owned response history."
    );
  }

  const input = responsesInputToAnthropicMessages(body.input, compaction);
  const translated: Record<string, unknown> = {
    model: body.model,
    messages: input.messages
  };
  const system = [...responsesSystem(body.instructions), ...input.system];
  if (system.length > 0) {
    translated.system = system;
  }
  const tools = [...responsesToolsToAnthropic(body.tools), ...input.tools];
  if (tools.length > 0) {
    translated.tools = tools;
  }
  const toolChoice = responsesToolChoiceToAnthropic(body.tool_choice);
  if (toolChoice) {
    translated.tool_choice = toolChoice;
  }
  let maxTokens = positiveInteger(body.max_output_tokens) ?? positiveInteger(body.max_tokens) ?? 8192;
  const temperature = finiteNumber(body.temperature);
  if (temperature !== null) {
    translated.temperature = temperature;
  }
  const topP = finiteNumber(body.top_p);
  if (topP !== null) {
    translated.top_p = topP;
  }
  const thinking = responsesThinkingToAnthropic(body.reasoning);
  if (thinking) {
    translated.thinking = thinking;
    maxTokens = Math.max(maxTokens, (positiveInteger(thinking.budget_tokens) ?? 0) + 1024);
  }
  translated.max_tokens = maxTokens;
  // Only meaningful alongside tools: Anthropic can express "no parallel calls" only
  // inside tool_choice, so a request that disabled parallel calls without naming a
  // choice had the instruction dropped entirely and the upstream was free to fan
  // out. But synthesizing a tool_choice for a request that declares no tools at all
  // sends a directive about tools that do not exist.
  if (body.parallel_tool_calls === false && tools.length > 0) {
    translated.tool_choice = { ...(toolChoice ?? { type: "auto" }), disable_parallel_tool_use: true };
  }
  if (body.stream === true) {
    translated.stream = true;
  }
  if (compaction) {
    translated.context_management = {
      edits: [{
        type: "compact_20260112",
        trigger: { type: "input_tokens", value: ANTHROPIC_COMPACTION_TRIGGER_TOKENS },
        pause_after_compaction: true
      }]
    };
  }

  return Buffer.from(JSON.stringify(translated));
}

export function encodeCompactGateCompactionSummary(summary: string): string {
  return encodeCompactGateState({ kind: "compaction_summary", summary });
}

export function decodeCompactGateCompactionSummary(value: unknown): string | null {
  const state = decodeCompactGateState(value);
  return state?.kind === "compaction_summary" && typeof state.summary === "string" && state.summary.trim()
    ? state.summary
    : null;
}

export function anthropicMessageToResponses(rawBody: Buffer, status: number): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Anthropic response body was not a JSON object.", 502);
  }
  if (status >= 400 || body.type === "error") {
    return Buffer.from(JSON.stringify(anthropicErrorToOpenAi(body, status)));
  }

  const content = Array.isArray(body.content) ? body.content : [];
  const output: unknown[] = [];
  const outputText: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      outputText.push(block.text);
      output.push({
        id: `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: block.text, annotations: [] }]
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      output.push({
        id: `rs_${randomUUID()}`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: block.thinking }],
        encrypted_content: encodeCompactGateState({
          kind: "anthropic_thinking",
          thinking: block.thinking,
          signature: typeof block.signature === "string" ? block.signature : ""
        })
      });
    } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
      output.push({
        id: `rs_${randomUUID()}`,
        type: "reasoning",
        summary: [],
        encrypted_content: encodeCompactGateState({ kind: "anthropic_redacted_thinking", data: block.data })
      });
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      output.push({
        id: `fc_${randomUUID()}`,
        type: "function_call",
        status: "completed",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(isRecord(block.input) ? block.input : {})
      });
    }
  }

  const usage = anthropicUsageToResponses(body.usage);
  const response: Record<string, unknown> = {
    id: typeof body.id === "string" ? body.id : `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: body.stop_reason === "max_tokens" ? "incomplete" : "completed",
    model: typeof body.model === "string" ? body.model : null,
    output,
    output_text: outputText.join(""),
    error: null,
    incomplete_details: body.stop_reason === "max_tokens" ? { reason: "max_output_tokens" } : null
  };
  if (usage) {
    response.usage = usage;
  }
  return Buffer.from(JSON.stringify(response));
}

export function anthropicMessageToResponsesCompaction(rawBody: Buffer, status: number): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Anthropic compaction response body was not a JSON object.", 502);
  }
  if (status >= 400 || body.type === "error") {
    return Buffer.from(JSON.stringify(anthropicErrorToOpenAi(body, status)));
  }

  const content = Array.isArray(body.content) ? body.content : [];
  const summary = content.reduce<string | null>((current, block) => {
    if (!isRecord(block) || block.type !== "compaction" || typeof block.content !== "string") {
      return current;
    }
    return block.content.trim() ? block.content : current;
  }, null);
  if (!summary) {
    throw new ProtocolConversionError(
      "Anthropic compaction response did not include a readable compaction block.",
      502
    );
  }

  const response: Record<string, unknown> = {
    id: typeof body.id === "string" ? body.id : `resp_${randomUUID()}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: [{
      type: "compaction",
      encrypted_content: encodeCompactGateCompactionSummary(summary)
    }]
  };
  const usage = anthropicUsageToResponses(body.usage);
  if (usage) {
    response.usage = usage;
  }
  return Buffer.from(JSON.stringify(response));
}

export function anthropicRequestToResponses(
  rawBody: Buffer,
  options: { countTokens?: boolean; includeCompaction?: boolean } = {}
): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Anthropic request body must be a JSON object.", 400);
  }
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    throw new ProtocolConversionError("Anthropic request requires a string model.", 400);
  }
  rejectUnsupportedAnthropicRequestFields(body);

  const input = anthropicMessagesToResponsesInput(
    body.system,
    body.messages,
    options.includeCompaction === true
  );
  const translated: Record<string, unknown> = {
    model: body.model,
    input
  };
  const tools = anthropicToolsToResponses(body.tools);
  if (tools.length > 0) {
    translated.tools = tools;
  }
  const toolChoice = anthropicToolChoiceToResponses(body.tool_choice);
  if (toolChoice.choice !== null) {
    translated.tool_choice = toolChoice.choice;
  }
  if (toolChoice.disableParallel) {
    translated.parallel_tool_calls = false;
  }
  const temperature = finiteNumber(body.temperature);
  if (temperature !== null) {
    translated.temperature = temperature;
  }
  const topP = finiteNumber(body.top_p);
  if (topP !== null) {
    translated.top_p = topP;
  }
  const reasoning = anthropicThinkingConfigToResponses(body.thinking, body.output_config);
  if (reasoning) {
    translated.reasoning = reasoning;
  }
  const textFormat = anthropicOutputFormatToResponses(body.output_config);
  if (textFormat) {
    translated.text = { format: textFormat };
  }
  const metadata = anthropicMetadataToResponses(body.metadata);
  if (metadata) {
    translated.metadata = metadata;
  }
  if (typeof body.service_tier === "string") {
    translated.service_tier = body.service_tier;
  }

  const countTokens = options.countTokens === true;
  if (!countTokens) {
    const maxTokens = positiveInteger(body.max_tokens);
    if (maxTokens !== null) {
      translated.max_output_tokens = maxTokens;
    }
    if (body.stream === true) {
      translated.stream = true;
    }
  }

  return Buffer.from(JSON.stringify(translated));
}

export function responsesRequestToChat(rawBody: Buffer): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Responses request body must be a JSON object.", 400);
  }
  if (typeof body.model !== "string" || body.model.trim().length === 0) {
    throw new ProtocolConversionError("Responses request requires a string model.", 400);
  }
  rejectUnsupportedResponsesChatFields(body);

  const input = responsesInputToChatMessages(body.instructions, body.input);
  const translated: Record<string, unknown> = {
    model: body.model,
    messages: input.messages
  };
  const tools = [...responsesToolsToChat(body.tools), ...input.tools];
  if (tools.length > 0) {
    translated.tools = tools;
  }
  const toolChoice = responsesToolChoiceToChat(body.tool_choice);
  if (toolChoice !== null) {
    translated.tool_choice = toolChoice;
  }
  // Only meaningful alongside tools, and OpenAI rejects the pair outright when
  // `tools` is absent. Same condition the Anthropic direction applies before it
  // synthesises `tool_choice`.
  if (body.parallel_tool_calls !== undefined && tools.length > 0) {
    translated.parallel_tool_calls = body.parallel_tool_calls === true;
  }
  const reasoningEffort = chatReasoningEffort(body.reasoning);
  if (reasoningEffort !== null) {
    translated.reasoning_effort = reasoningEffort;
  }
  const responseFormat = responsesTextFormatToChat(body.text);
  if (responseFormat) {
    translated.response_format = responseFormat;
  }

  const maxTokens = positiveInteger(body.max_output_tokens);
  if (maxTokens !== null) {
    translated.max_completion_tokens = maxTokens;
  }
  for (const field of [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "service_tier",
    "store",
    "user",
    "stop",
    "prompt_cache_key",
    "safety_identifier"
  ]) {
    if (body[field] !== undefined) {
      translated[field] = body[field];
    }
  }
  if (isRecord(body.metadata)) {
    translated.metadata = body.metadata;
  }
  if (body.stream === true) {
    translated.stream = true;
    translated.stream_options = { include_usage: true };
  }

  return Buffer.from(JSON.stringify(translated));
}

export function responsesRemoteV2CompactionToChat(rawBody: Buffer): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Responses request body must be a JSON object.", 400);
  }
  const input = Array.isArray(body.input) ? body.input : [];
  const retained = input.filter((item) => !isRecord(item) || item.type !== "compaction_trigger");
  retained.push({
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: "Create a concise summary of the conversation so far. Respond with summary text only."
    }]
  });
  const rewritten: Record<string, unknown> = {
    ...body,
    input: retained,
    stream: false
  };
  delete rewritten.previous_response_id;
  delete rewritten.previousResponseId;
  return responsesRequestToChat(Buffer.from(JSON.stringify(rewritten)));
}

export function anthropicRequestToChat(
  rawBody: Buffer,
  options: { countTokens?: boolean } = {}
): Buffer {
  if (options.countTokens === true) {
    throw new ProtocolConversionError(
      "OpenAI Chat upstream does not provide an Anthropic count_tokens equivalent.",
      501
    );
  }
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("Anthropic request body must be a JSON object.", 400);
  }
  rejectUnsupportedAnthropicChatFields(body);
  const responses = anthropicRequestToResponses(rawBody);
  return responsesRequestToChat(responses);
}

export function chatCompletionToResponses(rawBody: Buffer, status: number): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("OpenAI Chat response body was not a JSON object.", 502);
  }
  if (status >= 400 || isRecord(body.error)) {
    return Buffer.from(JSON.stringify(body));
  }

  const choices = Array.isArray(body.choices) ? body.choices : [];
  if (choices.length === 0 || !isRecord(choices[0])) {
    throw new ProtocolConversionError("OpenAI Chat response did not include a choice.", 502);
  }
  if (choices.length > 1) {
    throw new ProtocolConversionError("OpenAI Chat responses with multiple choices cannot be translated.", 502);
  }
  const choice = choices[0];
  const message = isRecord(choice.message) ? choice.message : null;
  if (!message || message.role !== "assistant") {
    throw new ProtocolConversionError("OpenAI Chat response choice did not include an assistant message.", 502);
  }

  const output: unknown[] = [];
  const outputText: string[] = [];
  const content = chatResponseContentToResponses(message.content);
  if (content.length > 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content
    });
    for (const part of content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        outputText.push(part.text);
      }
    }
  }
  if (typeof message.refusal === "string" && message.refusal.length > 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: message.refusal }]
    });
  }
  const toolCalls = chatToolCallsToResponses(message.tool_calls);
  output.push(...toolCalls);

  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";
  const incomplete = finishReason === "length" || finishReason === "content_filter";
  const response: Record<string, unknown> = {
    id: typeof body.id === "string" ? body.id : `resp_${randomUUID()}`,
    object: "response",
    created_at: nonNegativeInteger(body.created) ?? Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    model: typeof body.model === "string" ? body.model : null,
    output,
    output_text: outputText.join(""),
    error: null,
    incomplete_details: incomplete
      ? { reason: finishReason === "content_filter" ? "content_filter" : "max_output_tokens" }
      : null
  };
  const usage = chatUsageToResponses(body.usage);
  if (usage) {
    response.usage = usage;
  }
  return Buffer.from(JSON.stringify(response));
}

export function chatCompletionToResponsesCompaction(rawBody: Buffer, status: number): Buffer {
  const response = parseJsonRecord(chatCompletionToResponses(rawBody, status));
  if (!response || status >= 400) {
    return Buffer.from(JSON.stringify(response ?? { error: "Chat compaction response was invalid." }));
  }
  // A truncated summary (finish_reason "length" reports status "incomplete") is
  // still a summary, and the conversation's whole memory rides on it. Only the
  // absence of text is a failure — and it must be a loud one, because the caller
  // wraps whatever comes back in compaction events and announces completion.
  const summary = typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (!summary) {
    throw new ProtocolConversionError("OpenAI Chat compaction response did not include summary text.", 502);
  }
  const compacted: Record<string, unknown> = {
    id: typeof response.id === "string" ? response.id : `resp_${randomUUID()}`,
    object: "response.compaction",
    created_at: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    status: "completed",
    model: response.model,
    output: [{
      type: "compaction",
      encrypted_content: encodeCompactGateCompactionSummary(summary)
    }],
    usage: response.usage ?? null
  };
  return Buffer.from(JSON.stringify(compacted));
}

export function chatCompletionToAnthropic(rawBody: Buffer, status: number): Buffer {
  return openAiResponseToAnthropic(chatCompletionToResponses(rawBody, status), status);
}

export function chatUsageToResponses(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const inputTokens = nonNegativeInteger(value.prompt_tokens) ?? 0;
  const outputTokens = nonNegativeInteger(value.completion_tokens) ?? 0;
  const totalTokens = nonNegativeInteger(value.total_tokens) ?? inputTokens + outputTokens;
  const usage: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : null;
  const cachedTokens = nonNegativeInteger(promptDetails?.cached_tokens);
  if (cachedTokens !== null) {
    usage.input_tokens_details = { cached_tokens: cachedTokens };
  }
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : null;
  const reasoningTokens = nonNegativeInteger(completionDetails?.reasoning_tokens);
  if (reasoningTokens !== null) {
    usage.output_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  return usage;
}

export function openAiResponseToAnthropic(rawBody: Buffer, status: number): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("OpenAI response body was not a JSON object.", 502);
  }
  if (status >= 400 || isRecord(body.error)) {
    return Buffer.from(JSON.stringify(openAiErrorToAnthropic(body, status)));
  }

  const output = Array.isArray(body.output) ? body.output : [];
  const content = output.flatMap((item) => openAiOutputItemToAnthropic(item));
  if (content.length === 0 && typeof body.output_text === "string" && body.output_text.length > 0) {
    content.push({ type: "text", text: body.output_text });
  }
  const response: Record<string, unknown> = {
    id: anthropicMessageId(body.id),
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : null,
    content,
    stop_reason: openAiStopReason(body),
    stop_sequence: null,
    usage: openAiUsageToAnthropic(body.usage)
  };
  return Buffer.from(JSON.stringify(response));
}

export function openAiInputTokensToAnthropic(rawBody: Buffer, status: number): Buffer {
  const body = parseJsonRecord(rawBody);
  if (!body) {
    throw new ProtocolConversionError("OpenAI input-token response was not a JSON object.", 502);
  }
  if (status >= 400 || isRecord(body.error)) {
    return Buffer.from(JSON.stringify(openAiErrorToAnthropic(body, status)));
  }
  const inputTokens = nonNegativeInteger(body.input_tokens);
  if (inputTokens === null) {
    throw new ProtocolConversionError("OpenAI input-token response did not include input_tokens.", 502);
  }
  return Buffer.from(JSON.stringify({ input_tokens: inputTokens }));
}

export function openAiErrorToAnthropic(
  body: Record<string, unknown>,
  status: number
): Record<string, unknown> {
  const source = isRecord(body.error) ? body.error : body;
  return {
    type: "error",
    error: {
      type: anthropicErrorType(status, source.type),
      message: typeof source.message === "string"
        ? source.message
        : `OpenAI upstream returned HTTP ${status}.`
    }
  };
}

/**
 * OpenAI's `input_tokens` is the whole prompt, cache hits included; Anthropic's
 * is only the fresh remainder, with the cache counters additive on top. Copying
 * the field across and also emitting the cache counters would bill the cached
 * tokens twice — in the logs, in the analytics, and in the client's own context
 * display, since both proxies read usage back off the converted body.
 */
export function openAiUsageToAnthropic(value: unknown): Record<string, unknown> {
  const usage = isRecord(value) ? value : {};
  const promptTokens = nonNegativeInteger(usage.input_tokens) ?? 0;
  const outputTokens = nonNegativeInteger(usage.output_tokens) ?? 0;
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const cachedTokens = nonNegativeInteger(inputDetails?.cached_tokens);
  const cacheWriteTokens = nonNegativeInteger(inputDetails?.cache_write_tokens);
  const result: Record<string, unknown> = {
    input_tokens: Math.max(0, promptTokens - (cachedTokens ?? 0) - (cacheWriteTokens ?? 0)),
    output_tokens: outputTokens
  };
  if (cachedTokens !== null) {
    result.cache_read_input_tokens = cachedTokens;
  }
  if (cacheWriteTokens !== null) {
    result.cache_creation_input_tokens = cacheWriteTokens;
  }
  return result;
}

export function openAiStopReason(
  response: Record<string, unknown>
): "end_turn" | "max_tokens" | "tool_use" | "refusal" {
  if (
    response.status === "incomplete" &&
    isRecord(response.incomplete_details) &&
    response.incomplete_details.reason === "max_output_tokens"
  ) {
    return "max_tokens";
  }
  // A filtered turn reported as end_turn reached the client as an ordinary empty
  // assistant message, so it looked like the model simply had nothing to say.
  // Anthropic has a stop reason for exactly this.
  if (
    isRecord(response.incomplete_details) &&
    response.incomplete_details.reason === "content_filter"
  ) {
    return "refusal";
  }
  const output = Array.isArray(response.output) ? response.output : [];
  return output.some((item) => isRecord(item) && item.type === "function_call")
    ? "tool_use"
    : "end_turn";
}

export function anthropicErrorToOpenAi(
  body: Record<string, unknown>,
  status: number
): Record<string, unknown> {
  const source = isRecord(body.error) ? body.error : body;
  return {
    error: {
      message: typeof source.message === "string" ? source.message : `Anthropic upstream returned HTTP ${status}.`,
      type: typeof source.type === "string" ? source.type : "upstream_error",
      code: typeof source.type === "string" ? source.type : null
    }
  };
}

/** Inverse of {@link openAiUsageToAnthropic}: fold the additive Anthropic cache
 * counters back into the single OpenAI prompt total, and carry cache creation
 * across instead of dropping it. */
export function anthropicUsageToResponses(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const freshTokens = nonNegativeInteger(value.input_tokens) ?? 0;
  const outputTokens = nonNegativeInteger(value.output_tokens) ?? 0;
  const cachedTokens = nonNegativeInteger(value.cache_read_input_tokens) ?? 0;
  const cacheWriteTokens = nonNegativeInteger(value.cache_creation_input_tokens) ?? 0;
  const promptTokens = freshTokens + cachedTokens + cacheWriteTokens;
  const usage: Record<string, unknown> = {
    input_tokens: promptTokens,
    output_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens
  };
  if (cachedTokens > 0 || cacheWriteTokens > 0) {
    usage.input_tokens_details = {
      cached_tokens: cachedTokens,
      ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {})
    };
  }
  return usage;
}

function responsesSystem(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string" && value.length > 0) {
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return [{ type: "text", text: item }];
    }
    if (isRecord(item) && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    return [];
  });
}

/**
 * Chat has no `reasoning` object, but it does have a `reasoning_effort` scalar.
 * `rewritePrimaryBody` injects `reasoning: {effort}` from `primary.reasoning_effort`
 * on every /responses request, so an effort-only object has to translate rather
 * than be refused — otherwise CompactGate rejects the request it just built.
 *
 * Siblings of `effort` are ignored rather than disqualifying: Codex sends
 * `{context, effort}` on 100% of real requests, and the Anthropic→Responses
 * translation above produces `{effort, summary}`. Requiring a lone `effort` key
 * meant the carve-out never matched real traffic, so every such request fell
 * through to the blanket rejection. Nothing Chat accepts can express either
 * sibling, which is why dropping them is the whole of the translation.
 * The value is passed through verbatim; the upstream owns which efforts it takes.
 */
function chatReasoningEffort(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.effort === "string" && value.effort.length > 0 ? value.effort : null;
}

function rejectUnsupportedResponsesChatFields(body: Record<string, unknown>): void {
  for (const field of [
    "previous_response_id",
    "previousResponseId",
    "reasoning",
    "context_management",
    "conversation",
    "background",
    "prompt",
    "truncation"
  ]) {
    if (field === "reasoning" && chatReasoningEffort(body.reasoning) !== null) {
      continue;
    }
    if (Object.hasOwn(body, field)) {
      throw new ProtocolConversionError(`Responses ${field} cannot be translated to OpenAI Chat.`);
    }
  }
  // `include` only asks the upstream to echo extra fields back — Codex sends
  // `["reasoning.encrypted_content"]` on every request. Chat cannot produce those
  // fields whether we forward the ask or not, so ignoring it *is* the translation;
  // refusing it made every real Codex request 422.
  if (
    Object.hasOwn(body, "response_format") ||
    Object.hasOwn(body, "modalities") ||
    Object.hasOwn(body, "audio") ||
    Object.hasOwn(body, "max_tool_calls")
  ) {
    throw new ProtocolConversionError("Responses structured text output cannot be translated to OpenAI Chat.");
  }
  // `text` splits: `format` is a schema the caller parses against and maps onto
  // Chat's `response_format`, while `verbosity` (which Codex sends on every
  // request) is a style hint with no Chat counterpart and is dropped. An unknown
  // third key stays fail-loud rather than silently discarding a constraint.
  if (isRecord(body.text)) {
    const unsupported = Object.keys(body.text).find((key) => key !== "format" && key !== "verbosity");
    if (unsupported) {
      throw new ProtocolConversionError(`Responses text.${unsupported} cannot be translated to OpenAI Chat.`);
    }
  } else if (Object.hasOwn(body, "text")) {
    throw new ProtocolConversionError("Responses text must be an object to translate to OpenAI Chat.");
  }
}

/** Responses names its schema and Chat nests it; otherwise the shape is the same. */
function responsesTextFormatToChat(value: unknown): Record<string, unknown> | null {
  const format = isRecord(value) ? value.format : null;
  if (!isRecord(format) || format.type === "text") {
    return null;
  }
  if (format.type !== "json_schema" || !isRecord(format.schema)) {
    throw new ProtocolConversionError(
      `Responses text.format type ${String(format.type)} cannot be translated to OpenAI Chat.`
    );
  }
  return {
    type: "json_schema",
    json_schema: {
      name: readTrimmedText(format.name) ?? "response",
      schema: format.schema,
      strict: format.strict === true
    }
  };
}

function responsesInputToChatMessages(
  instructions: unknown,
  value: unknown
): { messages: Array<Record<string, unknown>>; tools: unknown[] } {
  const messages: Array<Record<string, unknown>> = [];
  const tools: unknown[] = [];
  const instructionText = responsesSystem(instructions)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
  if (instructionText) {
    messages.push({ role: "developer", content: instructionText });
  }
  if (typeof value === "string") {
    messages.push({ role: "user", content: value });
    return { messages, tools };
  }
  if (!Array.isArray(value)) {
    throw new ProtocolConversionError("Responses input must be a string or array.", 400);
  }

  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") {
      throw new ProtocolConversionError("Responses input items must be objects.", 400);
    }
    if (item.type === "message") {
      if (!["developer", "system", "user", "assistant"].includes(String(item.role))) {
        throw new ProtocolConversionError(`Unsupported Responses message role for OpenAI Chat: ${String(item.role)}.`);
      }
      messages.push({
        role: item.role,
        content: responsesContentToChat(item.content, item.role === "user" ? "user" : "text")
      });
      continue;
    }
    // Codex declares part of its tool set inside the input rather than in `tools`,
    // on 100% of real requests. Dropping the item would leave the upstream unaware
    // of tools the very next `custom_tool_call` item then calls, so the definitions
    // are lifted into the request's tool list instead.
    if (item.type === "additional_tools") {
      tools.push(...responsesToolsToChat(item.tools));
      continue;
    }
    if (
      (item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      // A custom tool takes freeform text where a function takes JSON; Chat has
      // only the function shape, whose `arguments` is itself a string.
      appendChatToolCall(messages, {
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.type === "custom_tool_call"
            ? typeof item.input === "string" ? item.input : chatToolArguments(item.input, 400)
            : chatToolArguments(item.arguments, 400)
        }
      });
      continue;
    }
    if (
      (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
      typeof item.call_id === "string"
    ) {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: toolOutputText(item.output)
      });
      continue;
    }
    // Reasoning and compaction items carry provider-encrypted state that only the
    // issuing provider can read. Chat has no field to carry it, so it is dropped:
    // the turn loses reasoning continuity, which is the cost of a Chat upstream,
    // and refusing instead made every request with a prior turn 422.
    if (item.type === "reasoning" || item.type === "compaction") {
      continue;
    }
    // A compaction_trigger *is* content — the instruction asking for the summary.
    if (item.type === "compaction_trigger") {
      messages.push({ role: "user", content: responsesContentToChat(item.content, "user") });
      continue;
    }
    throw new ProtocolConversionError(`Unsupported Responses input item type for OpenAI Chat: ${item.type}.`);
  }
  return { messages, tools };
}

function appendChatToolCall(
  messages: Array<Record<string, unknown>>,
  toolCall: Record<string, unknown>
): void {
  const previous = messages.at(-1);
  if (previous?.role === "assistant") {
    const toolCalls = Array.isArray(previous.tool_calls) ? previous.tool_calls : [];
    previous.tool_calls = [...toolCalls, toolCall];
    previous.content ??= null;
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
}

function responsesContentToChat(
  value: unknown,
  mode: "user" | "text"
): string | Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  const parts = value.map((block) => {
    if (!isRecord(block)) {
      throw new ProtocolConversionError("Responses content blocks must be objects.", 400);
    }
    if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (mode === "user" && block.type === "input_image" && typeof block.image_url === "string") {
      return {
        type: "image_url",
        image_url: {
          url: block.image_url,
          ...(typeof block.detail === "string" ? { detail: block.detail } : {})
        }
      };
    }
    throw new ProtocolConversionError(`Unsupported Responses content block type for OpenAI Chat: ${String(block.type)}.`);
  });
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => String(part.text ?? "")).join("");
  }
  return parts;
}

function responsesToolsToChat(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ProtocolConversionError("Responses tools must be an array.", 400);
  }
  return value.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string") {
      throw new ProtocolConversionError("Only function tools can be translated to OpenAI Chat.");
    }
    const definition: Record<string, unknown> = {
      name: tool.name,
      parameters: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} }
    };
    if (typeof tool.description === "string") {
      definition.description = tool.description;
    }
    if (typeof tool.strict === "boolean") {
      definition.strict = tool.strict;
    }
    return { type: "function", function: definition };
  });
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === "auto" || value === "none" || value === "required") {
    return value;
  }
  if (isRecord(value) && value.type === "function" && typeof value.name === "string") {
    return { type: "function", function: { name: value.name } };
  }
  throw new ProtocolConversionError("Unsupported Responses tool_choice for OpenAI Chat.");
}

function chatResponseContentToResponses(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return value.length > 0 ? [{ type: "output_text", text: value, annotations: [] }] : [];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ProtocolConversionError("OpenAI Chat response content was not text or an array.", 502);
  }
  return value.map((part) => {
    if (!isRecord(part)) {
      throw new ProtocolConversionError("OpenAI Chat response content parts must be objects.", 502);
    }
    if (part.type === "text" && typeof part.text === "string") {
      return { type: "output_text", text: part.text, annotations: [] };
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
      return { type: "refusal", refusal: part.refusal };
    }
    throw new ProtocolConversionError(`Unsupported OpenAI Chat response content type: ${String(part.type)}.`, 502);
  });
}

function chatToolCallsToResponses(value: unknown): Array<Record<string, unknown>> {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ProtocolConversionError("OpenAI Chat tool_calls must be an array.", 502);
  }
  return value.map((call) => {
    if (
      !isRecord(call) ||
      call.type !== "function" ||
      typeof call.id !== "string" ||
      !isRecord(call.function) ||
      typeof call.function.name !== "string"
    ) {
      throw new ProtocolConversionError("Only OpenAI Chat function tool calls can be translated.", 502);
    }
    return {
      id: `fc_${randomUUID()}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.function.name,
      arguments: chatToolArguments(call.function.arguments, 502)
    };
  });
}

function chatToolArguments(value: unknown, status: number): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  if (value === undefined || value === null) {
    return "{}";
  }
  throw new ProtocolConversionError("OpenAI Chat function arguments must be a JSON string or object.", status);
}

function rejectUnsupportedAnthropicRequestFields(body: Record<string, unknown>): void {
  if (Object.hasOwn(body, "top_k")) {
    throw new ProtocolConversionError("Anthropic top_k cannot be translated to OpenAI Responses.");
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    throw new ProtocolConversionError("Anthropic stop_sequences cannot be translated to OpenAI Responses.");
  }
  for (const field of ["mcp_servers", "container"]) {
    if (Object.hasOwn(body, field)) {
      throw new ProtocolConversionError(`Anthropic ${field} cannot be translated to OpenAI Responses.`);
    }
  }
  // `context_management` is dropped rather than refused. It is a server-side
  // context-editing directive — Claude Code sends
  // `{edits:[{type:"clear_thinking_…",keep:"all"}]}` on nearly every turn — and an
  // OpenAI upstream does not edit context at all. Ignoring it costs input tokens
  // and leaves prior thinking visible to the model; refusing it made *every* real
  // Claude Code request fail with a 422 before the upstream was ever contacted.
  //
  // `output_config` is translated instead of refused (see the two helpers below),
  // but only for the keys whose meaning is known. An unrecognised key stays
  // fail-loud: `format` carries a schema the client is about to parse against, so
  // silently dropping a future sibling of it would corrupt the answer rather than
  // merely degrade it.
  if (isRecord(body.output_config)) {
    const unsupported = Object.keys(body.output_config)
      .find((key) => key !== "effort" && key !== "format");
    if (unsupported) {
      throw new ProtocolConversionError(
        `Anthropic output_config.${unsupported} cannot be translated to OpenAI Responses.`
      );
    }
  }
}

function rejectUnsupportedAnthropicChatFields(body: Record<string, unknown>): void {
  rejectUnsupportedAnthropicRequestFields(body);
  // Thinking and prior thinking/compaction blocks used to be refused here. They
  // now translate through the same two hops the rest of this route takes —
  // Anthropic → Responses turns the config into `reasoning.effort` and the blocks
  // into reasoning items, and Responses → Chat maps the effort onto
  // `reasoning_effort` and drops the opaque items Chat has no field for. Refusing
  // them meant every Claude Code turn (which sends `thinking:{type:"adaptive"}`)
  // failed with a 422 before the upstream was contacted.
}

function anthropicMessagesToResponsesInput(
  system: unknown,
  messages: unknown,
  includeCompaction: boolean
): unknown[] {
  const input: unknown[] = [];
  const systemContent = anthropicSystemToResponsesContent(system);
  if (systemContent.length > 0) {
    input.push({ type: "message", role: "system", content: systemContent });
  }
  if (!Array.isArray(messages)) {
    throw new ProtocolConversionError("Anthropic messages must be an array.", 400);
  }

  // `system` is accepted inside `messages` because the `mid-conversation-system`
  // beta puts it there — Claude Code sends hook output as a positional system
  // message, and it has to stay at its position rather than be folded into the
  // top-level `system` field. Responses input takes a system message anywhere.
  for (const message of messages) {
    if (
      !isRecord(message) ||
      (message.role !== "user" && message.role !== "assistant" && message.role !== "system")
    ) {
      throw new ProtocolConversionError("Anthropic messages require user, assistant, or system roles.", 400);
    }
    appendAnthropicMessageToResponses(input, message.role, message.content, includeCompaction);
  }
  return input;
}

function anthropicSystemToResponsesContent(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    return value.length > 0 ? [{ type: "input_text", text: value }] : [];
  }
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ProtocolConversionError("Anthropic system must be a string or text block array.", 400);
  }
  return value.map((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new ProtocolConversionError("Only Anthropic system text blocks can be translated.");
    }
    return { type: "input_text", text: block.text };
  });
}

function appendAnthropicMessageToResponses(
  input: unknown[],
  role: "user" | "assistant" | "system",
  content: unknown,
  includeCompaction: boolean
): void {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks)) {
    throw new ProtocolConversionError("Anthropic message content must be a string or block array.", 400);
  }
  let messageContent: Array<Record<string, unknown>> = [];
  const flushMessage = () => {
    if (messageContent.length === 0) {
      return;
    }
    input.push({ type: "message", role, content: messageContent });
    messageContent = [];
  };

  for (const block of blocks) {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw new ProtocolConversionError("Anthropic content blocks must be objects.", 400);
    }
    if (block.type === "text" && typeof block.text === "string") {
      messageContent.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: block.text
      });
      continue;
    }
    if (block.type === "image") {
      if (role !== "user") {
        throw new ProtocolConversionError(`${role} image blocks cannot be translated to Responses input.`);
      }
      messageContent.push(anthropicImageToResponses(block));
      continue;
    }
    if (block.type === "document") {
      if (role !== "user") {
        throw new ProtocolConversionError(`${role} document blocks cannot be translated to Responses input.`);
      }
      messageContent.push(anthropicDocumentToResponses(block));
      continue;
    }

    flushMessage();
    if (block.type === "tool_use") {
      if (role !== "assistant" || typeof block.id !== "string" || typeof block.name !== "string") {
        throw new ProtocolConversionError("Anthropic tool_use requires an assistant role, id, and name.", 400);
      }
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(isRecord(block.input) ? block.input : {})
      });
    } else if (block.type === "tool_result") {
      if (role !== "user" || typeof block.tool_use_id !== "string") {
        throw new ProtocolConversionError("Anthropic tool_result requires a user role and tool_use_id.", 400);
      }
      input.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: anthropicToolResultToResponses(block.content, block.is_error === true)
      });
    } else if (block.type === "thinking") {
      if (role !== "assistant") {
        throw new ProtocolConversionError("Anthropic thinking blocks require an assistant role.", 400);
      }
      input.push(anthropicThinkingBlockToResponses(block.signature, block.thinking));
    } else if (block.type === "redacted_thinking") {
      if (role !== "assistant") {
        throw new ProtocolConversionError("Anthropic redacted_thinking blocks require an assistant role.", 400);
      }
      input.push(anthropicThinkingBlockToResponses(block.data, null));
    } else if (block.type === "compaction" && typeof block.content === "string") {
      if (role !== "assistant") {
        throw new ProtocolConversionError("Anthropic compaction blocks require an assistant role.", 400);
      }
      input.push(includeCompaction
        ? {
            type: "compaction",
            encrypted_content: encodeCompactGateCompactionSummary(block.content)
          }
        : {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: block.content }]
          });
    } else {
      throw new ProtocolConversionError(`Unsupported Anthropic content block type: ${block.type}.`);
    }
  }
  flushMessage();
}

function anthropicImageToResponses(block: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(block.source) || typeof block.source.type !== "string") {
    throw new ProtocolConversionError("Anthropic image source is required.", 400);
  }
  if (
    block.source.type === "base64" &&
    typeof block.source.media_type === "string" &&
    typeof block.source.data === "string"
  ) {
    return {
      type: "input_image",
      image_url: `data:${block.source.media_type};base64,${block.source.data}`
    };
  }
  if (block.source.type === "url" && typeof block.source.url === "string") {
    return { type: "input_image", image_url: block.source.url };
  }
  throw new ProtocolConversionError("Unsupported Anthropic image source.");
}

function anthropicDocumentToResponses(block: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(block.source) || typeof block.source.type !== "string") {
    throw new ProtocolConversionError("Anthropic document source is required.", 400);
  }
  if (
    block.source.type === "base64" &&
    typeof block.source.media_type === "string" &&
    typeof block.source.data === "string"
  ) {
    return {
      type: "input_file",
      file_data: `data:${block.source.media_type};base64,${block.source.data}`,
      mime_type: block.source.media_type
    };
  }
  if (block.source.type === "url" && typeof block.source.url === "string") {
    return { type: "input_file", file_url: block.source.url };
  }
  throw new ProtocolConversionError("Unsupported Anthropic document source.");
}

function anthropicToolResultToResponses(content: unknown, isError: boolean): unknown {
  if (typeof content === "string") {
    return isError ? `[tool_error]\n${content}` : content;
  }
  if (!Array.isArray(content)) {
    return isError ? "[tool_error]" : "";
  }
  const output = content.map((block) => {
    if (!isRecord(block)) {
      throw new ProtocolConversionError("Anthropic tool_result blocks must be objects.", 400);
    }
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "input_text", text: block.text };
    }
    if (block.type === "image") {
      return anthropicImageToResponses(block);
    }
    if (block.type === "document") {
      return anthropicDocumentToResponses(block);
    }
    throw new ProtocolConversionError(`Unsupported Anthropic tool_result block type: ${String(block.type)}.`);
  });
  return isError
    ? [{ type: "input_text", text: "[tool_error]" }, ...output]
    : output;
}

function anthropicThinkingBlockToResponses(stateValue: unknown, thinking: unknown): Record<string, unknown> {
  const state = decodeCompactGateState(stateValue);
  if (state?.kind !== "openai_reasoning") {
    throw new ProtocolConversionError("Opaque thinking state was not created by CompactGate.");
  }
  const summary = typeof thinking === "string" && thinking.length > 0
    ? thinking
    : typeof state.summary === "string"
      ? state.summary
      : "";
  const reasoning: Record<string, unknown> = {
    type: "reasoning",
    summary: summary ? [{ type: "summary_text", text: summary }] : []
  };
  if (typeof state.encrypted_content === "string" && state.encrypted_content.length > 0) {
    reasoning.encrypted_content = state.encrypted_content;
  }
  return reasoning;
}

function anthropicToolsToResponses(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ProtocolConversionError("Anthropic tools must be an array.", 400);
  }
  return value.map((tool) => {
    if (
      !isRecord(tool) ||
      (tool.type !== undefined && tool.type !== "custom") ||
      typeof tool.name !== "string" ||
      !isRecord(tool.input_schema)
    ) {
      throw new ProtocolConversionError("Only Anthropic client tools can be translated to Responses.");
    }
    const translated: Record<string, unknown> = {
      type: "function",
      name: tool.name,
      parameters: tool.input_schema
    };
    if (typeof tool.description === "string") {
      translated.description = tool.description;
    }
    return translated;
  });
}

function anthropicToolChoiceToResponses(value: unknown): {
  choice: unknown;
  disableParallel: boolean;
} {
  if (value === undefined) {
    return { choice: null, disableParallel: false };
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProtocolConversionError("Anthropic tool_choice must be an object.", 400);
  }
  const disableParallel = value.disable_parallel_tool_use === true;
  if (value.type === "auto" || value.type === "none") {
    return { choice: value.type, disableParallel };
  }
  if (value.type === "any") {
    return { choice: "required", disableParallel };
  }
  if (value.type === "tool" && typeof value.name === "string") {
    return { choice: { type: "function", name: value.name }, disableParallel };
  }
  throw new ProtocolConversionError("Unsupported Anthropic tool_choice for Responses.");
}

function anthropicThinkingConfigToResponses(
  value: unknown,
  outputConfig: unknown
): Record<string, unknown> | null {
  if (!isRecord(value) || value.type === "disabled") {
    return null;
  }
  if (value.type === "adaptive") {
    // The adaptive dialect carries no token count — the level lives in
    // `output_config.effort`, which is where every current Claude Code request
    // puts it. Hardcoding "high" silently discarded max/medium/low/minimal.
    return { effort: anthropicEffortToResponses(outputConfig) ?? "high", summary: "auto" };
  }
  if (value.type !== "enabled") {
    throw new ProtocolConversionError("Unsupported Anthropic thinking configuration.");
  }
  const budget = positiveInteger(value.budget_tokens) ?? 4096;
  const effort = budget <= 2048 ? "low" : budget <= 4096 ? "medium" : budget <= 8192 ? "high" : "xhigh";
  return { effort, summary: "auto" };
}

/** Anthropic's top tier has no Responses counterpart under the same name. */
function anthropicEffortToResponses(outputConfig: unknown): string | null {
  const effort = isRecord(outputConfig) ? readTrimmedText(outputConfig.effort)?.toLowerCase() : null;
  if (!effort) {
    return null;
  }
  return effort === "max" ? "xhigh" : effort;
}

/**
 * Anthropic's structured-output constraint. Claude Code uses it for the calls
 * whose answer it immediately parses (naming a session, picking a branch), so
 * this one cannot be dropped the way `context_management` can: handing back
 * free-form prose where the caller is about to `JSON.parse` turns a degraded
 * answer into a broken one. Responses requires the schema to be named and
 * Anthropic does not name it, so supply one.
 */
function anthropicOutputFormatToResponses(value: unknown): Record<string, unknown> | null {
  const format = isRecord(value) ? value.format : null;
  if (!isRecord(format)) {
    return null;
  }
  if (format.type !== "json_schema" || !isRecord(format.schema)) {
    throw new ProtocolConversionError(
      `Anthropic output_config.format type ${String(format.type)} cannot be translated to OpenAI Responses.`
    );
  }
  return {
    type: "json_schema",
    name: readTrimmedText(format.name) ?? "response",
    schema: format.schema,
    strict: true
  };
}

function readTrimmedText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function anthropicMetadataToResponses(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const metadata = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean"
      )
      .map(([name, item]) => [name, String(item)])
  );
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function openAiOutputItemToAnthropic(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ProtocolConversionError("OpenAI output items must be objects.", 502);
  }
  if (value.type === "message") {
    if (!Array.isArray(value.content)) {
      return [];
    }
    return value.content.map((part) => {
      if (!isRecord(part)) {
        throw new ProtocolConversionError("OpenAI message content parts must be objects.", 502);
      }
      if (part.type === "output_text" && typeof part.text === "string") {
        return { type: "text", text: part.text };
      }
      if (part.type === "refusal" && typeof part.refusal === "string") {
        return { type: "text", text: part.refusal };
      }
      throw new ProtocolConversionError(`Unsupported OpenAI output content type: ${String(part.type)}.`, 502);
    });
  }
  if (value.type === "function_call" && typeof value.call_id === "string" && typeof value.name === "string") {
    return [{
      type: "tool_use",
      id: value.call_id,
      name: value.name,
      input: parseToolArguments(
        value.arguments,
        502,
        "OpenAI function call arguments were not valid JSON.",
        "OpenAI function call arguments were not a JSON object."
      )
    }];
  }
  if (value.type === "reasoning") {
    const block = openAiReasoningToAnthropic(value);
    return block ? [block] : [];
  }
  throw new ProtocolConversionError(`Unsupported OpenAI output item type: ${value.type}.`, 502);
}

export function openAiReasoningToAnthropic(
  value: Record<string, unknown>
): Record<string, unknown> | null {
  const summary = Array.isArray(value.summary)
    ? value.summary.flatMap((part) =>
        isRecord(part) && typeof part.text === "string" ? [part.text] : []
      ).join("")
    : "";
  const encryptedContent = typeof value.encrypted_content === "string" ? value.encrypted_content : "";
  if (!summary && !encryptedContent) {
    return null;
  }
  const state = encodeCompactGateState({
    kind: "openai_reasoning",
    encrypted_content: encryptedContent,
    summary
  });
  return summary
    ? { type: "thinking", thinking: summary, signature: state }
    : { type: "redacted_thinking", data: state };
}

function anthropicMessageId(value: unknown): string {
  if (typeof value === "string" && value.startsWith("msg_")) {
    return value;
  }
  return `msg_${randomUUID()}`;
}

function anthropicErrorType(status: number, sourceType: unknown): string {
  if (status === 400 || status === 422) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return typeof sourceType === "string" ? sourceType : "api_error";
}

function responsesInputToAnthropicMessages(value: unknown, allowCompactionTrigger: boolean): {
  messages: Array<Record<string, unknown>>;
  system: Array<Record<string, unknown>>;
  tools: unknown[];
} {
  if (typeof value === "string") {
    return {
      messages: [{ role: "user", content: [{ type: "text", text: value }] }],
      system: [],
      tools: []
    };
  }
  if (!Array.isArray(value)) {
    throw new ProtocolConversionError("Responses input must be a string or array.", 400);
  }

  const messages: Array<Record<string, unknown>> = [];
  const system: Array<Record<string, unknown>> = [];
  const tools: unknown[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      throw new ProtocolConversionError("Responses input items must be objects.", 400);
    }
    if (item.type === "message") {
      const content = responsesContentToAnthropic(item.content);
      if (item.role === "system" || item.role === "developer") {
        system.push(...content.filter(isRecord));
      } else {
        const role = item.role === "assistant" ? "assistant" : "user";
        pushAnthropicMessage(messages, role, content);
      }
    } else if (item.type === "additional_tools") {
      // Codex declares part of its tool set inside the input rather than in
      // `tools`, on 100% of real requests. Refusing the item made every Codex
      // request 422 here; dropping it would leave the upstream unaware of tools
      // the very next custom_tool_call item goes on to call.
      tools.push(...responsesToolsToAnthropic(item.tools));
    } else if (
      (item.type === "function_call" || item.type === "custom_tool_call") &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      pushAnthropicMessage(messages, "assistant", [{
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        // A custom tool takes freeform text where a function takes JSON, and
        // Anthropic's tool_use.input is always an object — so the raw text is
        // carried under a single key rather than being parsed as JSON it is not.
        input: item.type === "custom_tool_call"
          ? typeof item.input === "string"
            ? { input: item.input }
            : parseToolArguments(item.input, 400, "Custom tool call input must be text or a JSON object.")
          : parseToolArguments(item.arguments, 400, "Function call arguments must be a JSON object.")
      }]);
    } else if (
      (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
      typeof item.call_id === "string"
    ) {
      pushAnthropicMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: item.call_id,
        content: toolOutputText(item.output)
      }]);
    } else if (item.type === "reasoning") {
      const state = decodeCompactGateState(item.encrypted_content);
      if (state?.kind === "anthropic_thinking" && typeof state.thinking === "string") {
        const thinking: Record<string, unknown> = { type: "thinking", thinking: state.thinking };
        if (typeof state.signature === "string" && state.signature.length > 0) {
          thinking.signature = state.signature;
        }
        pushAnthropicMessage(messages, "assistant", [thinking]);
      } else if (state?.kind === "anthropic_redacted_thinking" && typeof state.data === "string") {
        pushAnthropicMessage(messages, "assistant", [{ type: "redacted_thinking", data: state.data }]);
      } else {
        throw new ProtocolConversionError("Opaque reasoning state was not created by CompactGate.");
      }
    } else if (item.type === "compaction") {
      const summary = decodeCompactGateCompactionSummary(item.encrypted_content);
      if (!summary) {
        throw new ProtocolConversionError("Opaque compaction state was not created by CompactGate.");
      }
      pushAnthropicMessage(messages, "assistant", [{ type: "compaction", content: summary }]);
    } else if (item.type === "compaction_trigger") {
      if (!allowCompactionTrigger) {
        throw new ProtocolConversionError("compaction_trigger requires a compaction request.");
      }
      pushAnthropicMessage(messages, "user", responsesContentToAnthropic(item.content));
    } else {
      throw new ProtocolConversionError(`Unsupported Responses input item type: ${String(item.type)}.`);
    }
  }
  return { messages, system, tools };
}

function pushAnthropicMessage(
  messages: Array<Record<string, unknown>>,
  role: "user" | "assistant",
  content: unknown[]
): void {
  if (content.length === 0) {
    return;
  }
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...content);
    return;
  }
  messages.push({ role, content });
}

function responsesContentToAnthropic(value: unknown): unknown[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((block) => {
    if (!isRecord(block)) {
      throw new ProtocolConversionError("Responses content blocks must be objects.", 400);
    }
    if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (block.type === "input_image") {
      return responsesImageToAnthropic(block);
    }
    if (block.type === "input_file") {
      return responsesFileToAnthropic(block);
    }
    throw new ProtocolConversionError(`Unsupported Responses content block type: ${String(block.type)}.`);
  });
}

function responsesFileToAnthropic(block: Record<string, unknown>): Record<string, unknown> {
  const fileData = typeof block.file_data === "string" ? block.file_data : null;
  const fileUrl = typeof block.file_url === "string" ? block.file_url : null;
  const mediaType = typeof block.mime_type === "string" ? block.mime_type : "application/pdf";
  if (fileData) {
    const match = fileData.match(/^data:([^;,]+);base64,(.+)$/s);
    return {
      type: "document",
      source: { type: "base64", media_type: match?.[1] ?? mediaType, data: match?.[2] ?? fileData }
    };
  }
  if (fileUrl) {
    return { type: "document", source: { type: "url", url: fileUrl } };
  }
  throw new ProtocolConversionError("Responses input_file requires file_data or file_url.");
}

function responsesImageToAnthropic(block: Record<string, unknown>): Record<string, unknown> {
  if (typeof block.image_url !== "string") {
    throw new ProtocolConversionError("Responses input_image requires image_url.", 400);
  }
  const match = block.image_url.match(/^data:([^;,]+);base64,(.+)$/s);
  if (match) {
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] }
    };
  }
  return { type: "image", source: { type: "url", url: block.image_url } };
}

function responsesToolsToAnthropic(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || typeof tool.name !== "string") {
      throw new ProtocolConversionError("Only function tools can be translated to Anthropic Messages.");
    }
    const translated: Record<string, unknown> = {
      name: tool.name,
      input_schema: isRecord(tool.parameters) ? tool.parameters : { type: "object", properties: {} }
    };
    if (typeof tool.description === "string") {
      translated.description = tool.description;
    }
    return translated;
  });
}

function responsesToolChoiceToAnthropic(value: unknown): Record<string, unknown> | null {
  if (value === "auto" || value === undefined) {
    return value === "auto" ? { type: "auto" } : null;
  }
  if (value === "none") {
    return { type: "none" };
  }
  if (value === "required") {
    return { type: "any" };
  }
  if (isRecord(value) && value.type === "function" && typeof value.name === "string") {
    return { type: "tool", name: value.name };
  }
  throw new ProtocolConversionError("Unsupported Responses tool_choice for Anthropic Messages.");
}

function responsesThinkingToAnthropic(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const effort = typeof value.effort === "string" ? value.effort : "";
  if (!effort || effort === "none") {
    return null;
  }
  const budgetByEffort: Record<string, number> = {
    low: 2048,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
    max: 32768
  };
  return { type: "enabled", budget_tokens: budgetByEffort[effort] ?? 4096 };
}

/**
 * Parses a tool-call `arguments` payload into an object. Callers supply the
 * status and messages because the two directions report differently: the
 * OpenAI->Anthropic path distinguishes "not valid JSON" from "not an object"
 * as 502s, while the request path reports one 400 for both.
 */
function parseToolArguments(
  value: unknown,
  status: number,
  invalidJsonMessage: string,
  notObjectMessage = invalidJsonMessage
): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    throw new ProtocolConversionError(invalidJsonMessage, status);
  }
  throw new ProtocolConversionError(notObjectMessage, status);
}

/**
 * A Chat `tool` message carries one string, but a Responses function_call_output
 * (and the Anthropic tool_result it was converted from) carries content blocks.
 * Stringifying the array handed the model raw JSON markup instead of the tool's
 * output — the normal path, since Claude Code always sends block arrays.
 */
function toolOutputText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toolOutputBlockText).join("\n");
  }
  return JSON.stringify(value ?? null);
}

function toolOutputBlockText(block: unknown): string {
  if (typeof block === "string") {
    return block;
  }
  if (!isRecord(block)) {
    return JSON.stringify(block ?? null);
  }
  if (typeof block.text === "string") {
    return block.text;
  }
  // An image cannot travel in a Chat tool message. Name it rather than inlining
  // base64 the model still cannot see but would be billed for as text.
  if (typeof block.type === "string" && block.type.includes("image")) {
    return "[image]";
  }
  return JSON.stringify(block);
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasCompactionTrigger(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => isRecord(item) && item.type === "compaction_trigger");
}
