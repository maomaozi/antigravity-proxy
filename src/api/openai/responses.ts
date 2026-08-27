import type {
  CompletionContentPart,
  CompletionMessage,
  CompletionRequest,
  CompletionResponseFormat,
  CompletionResult,
  CompletionStreamEvent,
  CompletionTool,
  CompletionToolCall,
  CompletionUsage,
} from "../../core/completion";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function outputString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (part?.type === "input_text" || part?.type === "output_text") return String(part.text ?? "");
        return JSON.stringify(part);
      })
      .join("");
  }
  return JSON.stringify(value ?? "");
}

function adaptMessageContent(content: unknown): string | CompletionContentPart[] | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts: CompletionContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image", url: part.image_url });
    }
  }
  return parts;
}

function extractReasoningText(item: any): string {
  const content = Array.isArray(item?.content)
    ? item.content
        .filter((part: any) => part?.type === "reasoning_text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("")
    : "";
  if (content) return content;
  return Array.isArray(item?.summary)
    ? item.summary
        .filter((part: any) => part?.type === "summary_text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("")
    : "";
}

function adaptResponseFormat(text: any): CompletionResponseFormat | undefined {
  const format = text?.format;
  if (!format || typeof format !== "object" || format.type === "text") return format ? { type: "text" } : undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      name: asString(format.name),
      schema: format.schema,
      strict: typeof format.strict === "boolean" ? format.strict : undefined,
    };
  }
  return undefined;
}

function adaptTool(tool: any): CompletionTool {
  return {
    name: String(tool?.name ?? ""),
    description: asString(tool?.description),
    parameters: tool?.parameters,
    strict: typeof tool?.strict === "boolean" ? tool.strict : undefined,
  };
}

function adaptInputItems(input: unknown, instructions: unknown): CompletionMessage[] {
  const items = typeof input === "string"
    ? [{ role: "user", content: input }]
    : (Array.isArray(input) ? input : []);
  const messages: CompletionMessage[] = [];
  const systemParts: string[] = [];
  if (typeof instructions === "string" && instructions) systemParts.push(instructions);

  let pendingReasoning = "";
  let pendingToolCalls: CompletionToolCall[] = [];

  const flushAssistant = (content: string | CompletionContentPart[] | null = null) => {
    if (!pendingReasoning && pendingToolCalls.length === 0 && content == null) return;
    messages.push({
      role: "assistant",
      content,
      reasoningContent: pendingReasoning || undefined,
      toolCalls: pendingToolCalls.length ? pendingToolCalls : undefined,
    });
    pendingReasoning = "";
    pendingToolCalls = [];
  };

  for (const item of items as any[]) {
    if (!item || typeof item !== "object") continue;
    const type = item.type;

    if (type === "reasoning") {
      pendingReasoning += extractReasoningText(item);
      continue;
    }

    if (type === "function_call") {
      pendingToolCalls.push({
        id: String(item.call_id ?? ""),
        name: String(item.name ?? ""),
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
      continue;
    }

    if (type === "function_call_output") {
      flushAssistant();
      messages.push({
        role: "tool",
        content: outputString(item.output),
        toolCallId: String(item.call_id ?? ""),
        name: asString(item.name),
      });
      continue;
    }

    if (type === "message" || type == null || typeof item.role === "string") {
      const role = String(item.role ?? "user");
      const content = adaptMessageContent(item.content);
      if (role === "system" || role === "developer") {
        flushAssistant();
        if (typeof content === "string") systemParts.push(content);
        else if (Array.isArray(content)) {
          systemParts.push(content.filter(part => part.type === "text").map(part => part.text).join(""));
        }
      } else if (role === "assistant") {
        flushAssistant(content);
      } else {
        flushAssistant();
        messages.push({ role: "user", content });
      }
    }
  }

  flushAssistant();
  if (systemParts.length) messages.unshift({ role: "system", content: systemParts.filter(Boolean).join("\n\n") });
  return messages;
}

export function adaptResponsesRequest(body: any): CompletionRequest {
  return {
    model: typeof body?.model === "string" ? body.model : "",
    messages: adaptInputItems(body?.input, body?.instructions),
    tools: Array.isArray(body?.tools) ? body.tools.map(adaptTool) : undefined,
    responseFormat: adaptResponseFormat(body?.text),
    reasoningEffort: typeof body?.reasoning?.effort === "string" ? body.reasoning.effort : undefined,
    maxOutputTokens: typeof body?.max_output_tokens === "number" ? body.max_output_tokens : undefined,
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    topP: typeof body?.top_p === "number" ? body.top_p : undefined,
    stream: body?.stream === true,
    promptCacheKey: typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
    metadata: body?.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
  };
}

function validateContent(content: any): string | undefined {
  if (typeof content === "string") return undefined;
  if (!Array.isArray(content)) return "Message content must be a string or supported content array.";
  for (const part of content) {
    if (!part || typeof part !== "object") return "Message content items must be objects.";
    if (["input_text", "output_text", "text"].includes(part.type)) continue;
    if (part.type === "input_image") {
      if (part.file_id) return "Responses input_image file_id is not supported; use a base64 data URL.";
      if (typeof part.image_url !== "string" || !part.image_url.startsWith("data:")) {
        return "Responses input_image currently requires a base64 data URL.";
      }
      continue;
    }
    return `Unsupported Responses content item type: ${String(part.type)}.`;
  }
  return undefined;
}

export function validateResponsesRequest(body: any): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Request body must be a JSON object.";
  if (typeof body.model !== "string" || !body.model.trim()) return "model is required.";
  if (body.previous_response_id != null) return "previous_response_id is not supported; provide the complete ordered history in input.";
  if (body.conversation != null) return "conversation is not supported; provide the complete ordered history in input.";
  if (body.store === true) return "store=true is not supported because this proxy does not persist Responses objects.";
  if (body.background === true) return "background Responses are not supported.";
  if (body.prompt != null) return "Reusable prompt templates are not supported.";
  if (Array.isArray(body.include) && body.include.length) {
    const unsupportedIncludes = body.include.filter((value: unknown) => value !== "reasoning.encrypted_content");
    if (unsupportedIncludes.length) {
      return `Unsupported Responses include expansion: ${String(unsupportedIncludes[0])}.`;
    }
  }
  if (body.tool_choice != null && body.tool_choice !== "auto") return "Only tool_choice=auto is supported.";
  if (body.parallel_tool_calls === false) return "parallel_tool_calls=false is not supported by the current upstream protocol.";
  if (body.truncation != null && body.truncation !== "disabled") return "Only truncation=disabled is supported.";
  if (body.text?.verbosity != null) return "text.verbosity is not supported.";
  if (body.instructions != null && typeof body.instructions !== "string") return "instructions must be a string.";
  if (body.reasoning?.effort != null && !["low", "medium", "high"].includes(body.reasoning.effort)) {
    return "reasoning.effort must be low, medium, or high.";
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.type !== "function") return "Only custom function tools are supported by /v1/responses.";
      if (typeof tool.name !== "string" || !tool.name) return "Every function tool must have a non-empty name.";
    }
  }

  if (!(typeof body.input === "string" || Array.isArray(body.input))) return "input must be a string or a non-empty array.";
  if (typeof body.input === "string") {
    if (!body.input) return "input must not be empty.";
    return undefined;
  }
  if (body.input.length === 0) return "input must not be empty.";

  for (const item of body.input) {
    if (!item || typeof item !== "object") return "Responses input items must be objects.";
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id) return "Every function_call must have a non-empty call_id.";
      if (typeof item.name !== "string" || !item.name) return "Every function_call must have a non-empty name.";
      if (typeof item.arguments !== "string") return "function_call.arguments must be a JSON string.";
      try { JSON.parse(item.arguments || "{}"); } catch { return `Function call ${item.call_id} contains invalid JSON arguments.`; }
      continue;
    }
    if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || !item.call_id) return "Every function_call_output must have a non-empty call_id.";
      if (!(typeof item.output === "string" || Array.isArray(item.output))) return "function_call_output.output must be a string or content array.";
      if (Array.isArray(item.output)) {
        const error = validateContent(item.output);
        if (error) return error;
      }
      continue;
    }
    if (item.type === "message" || item.type == null || typeof item.role === "string") {
      if (!["user", "assistant", "system", "developer"].includes(item.role)) return `Unsupported message role: ${String(item.role)}.`;
      const error = validateContent(item.content);
      if (error) return error;
      continue;
    }
    return `Unsupported Responses input item type: ${String(item.type)}.`;
  }
  return undefined;
}

function encodeUsage(usage: CompletionUsage | undefined): any {
  if (!usage) return undefined;
  const reasoningTokens = usage.reasoningTokensReported ? usage.reasoningTokens : 0;
  // Responses counts reasoning inside output_tokens; Chat Completions in this proxy
  // intentionally keeps visible completion tokens separate. Keep that distinction
  // at the protocol encoder boundary rather than changing persisted upstream usage.
  const outputTokens = usage.outputTokens + reasoningTokens;
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: {
      cached_tokens: usage.cachedInputTokens ?? 0,
      cache_write_tokens: 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: reasoningTokens,
    },
    total_tokens: usage.inputTokens + outputTokens,
  };
}

function itemSuffix(responseId: string): string {
  return responseId.replace(/^resp_/, "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "response";
}

function buildOutput(responseId: string, result: CompletionResult): any[] {
  const suffix = itemSuffix(responseId);
  const output: any[] = [];
  let ordinal = 0;
  const itemStatus = result.finishReason === "length" || result.finishReason === "content_filter" ? "incomplete" : "completed";

  if (result.reasoning) {
    output.push({
      id: `rs_${suffix}_${ordinal++}`,
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: result.reasoning }],
      status: itemStatus,
    });
  }
  if (result.text) {
    output.push({
      id: `msg_${suffix}_${ordinal++}`,
      type: "message",
      role: "assistant",
      status: itemStatus,
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    });
  }
  for (const call of result.toolCalls) {
    output.push({
      id: `fc_${suffix}_${ordinal++}`,
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  return output;
}

function responseStatus(result: CompletionResult): { status: "completed" | "incomplete"; incomplete: any } {
  if (result.finishReason === "length") return { status: "incomplete", incomplete: { reason: "max_output_tokens" } };
  if (result.finishReason === "content_filter") return { status: "incomplete", incomplete: { reason: "content_filter" } };
  return { status: "completed", incomplete: null };
}

export interface ResponsesResultContext {
  responseId: string;
  createdAt: number;
  requestBody: any;
  result: CompletionResult;
}

export function encodeResponsesResult({ responseId, createdAt, requestBody, result }: ResponsesResultContext): any {
  const { status, incomplete } = responseStatus(result);
  const response: any = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    output_text: result.text,
    error: null,
    incomplete_details: incomplete,
    instructions: typeof requestBody?.instructions === "string" ? requestBody.instructions : null,
    metadata: requestBody?.metadata ?? null,
    model: requestBody?.model,
    output: buildOutput(responseId, result),
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    temperature: typeof requestBody?.temperature === "number" ? requestBody.temperature : null,
    tool_choice: requestBody?.tool_choice ?? "auto",
    tools: Array.isArray(requestBody?.tools) ? requestBody.tools : [],
    top_p: typeof requestBody?.top_p === "number" ? requestBody.top_p : null,
    background: false,
    conversation: null,
    max_output_tokens: typeof requestBody?.max_output_tokens === "number" ? requestBody.max_output_tokens : null,
    previous_response_id: null,
    prompt_cache_key: requestBody?.prompt_cache_key ?? null,
    reasoning: requestBody?.reasoning ?? null,
    status,
    text: requestBody?.text ?? { format: { type: "text" } },
    truncation: requestBody?.truncation ?? "disabled",
    usage: encodeUsage(result.usage),
    store: requestBody?.store ?? false,
  };
  if (status === "completed") response.completed_at = Math.max(createdAt, Math.floor(Date.now() / 1000));
  return response;
}

export interface ResponsesStreamContext {
  responseId: string;
  model: string;
  createdAt: number;
  requestBody: any;
}

type StreamItemState =
  | { kind: "reasoning"; id: string; outputIndex: number; text: string }
  | { kind: "message"; id: string; outputIndex: number; text: string }
  | { kind: "function_call"; id: string; outputIndex: number; callId: string; name: string; arguments: string };

export function createResponsesStreamEncoder(context: ResponsesStreamContext): TransformStream<CompletionStreamEvent, Uint8Array> {
  const encoder = new TextEncoder();
  let sequence = 0;
  let nextOutputIndex = 0;
  let reasoningState: Extract<StreamItemState, { kind: "reasoning" }> | undefined;
  let messageState: Extract<StreamItemState, { kind: "message" }> | undefined;
  const toolStates = new Map<string, Extract<StreamItemState, { kind: "function_call" }>>();
  const orderedStates: StreamItemState[] = [];
  let finishReason: CompletionResult["finishReason"] = "stop";
  let usage: CompletionUsage | undefined;
  let finalized = false;

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, event: any) => {
    const withSequence = { ...event, sequence_number: sequence++ };
    controller.enqueue(encoder.encode(`event: ${withSequence.type}\ndata: ${JSON.stringify(withSequence)}\n\n`));
  };

  const currentResult = (): CompletionResult => ({
    reasoning: reasoningState?.text ?? "",
    text: messageState?.text ?? "",
    toolCalls: orderedStates
      .filter((state): state is Extract<StreamItemState, { kind: "function_call" }> => state.kind === "function_call")
      .map((state, index) => ({ index, id: state.callId, name: state.name, arguments: state.arguments })),
    finishReason,
    usage,
  });

  const inProgressResponse = () => {
    const result = currentResult();
    return {
      ...encodeResponsesResult({ ...context, result }),
      status: "in_progress",
      completed_at: undefined,
      incomplete_details: null,
      output: [],
      output_text: "",
      usage: undefined,
    };
  };

  const ensureReasoning = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (reasoningState) return reasoningState;
    const state: Extract<StreamItemState, { kind: "reasoning" }> = {
      kind: "reasoning",
      id: `rs_${itemSuffix(context.responseId)}_${nextOutputIndex}`,
      outputIndex: nextOutputIndex++,
      text: "",
    };
    reasoningState = state;
    orderedStates.push(state);
    emit(controller, {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: { id: state.id, type: "reasoning", summary: [], content: [], status: "in_progress" },
    });
    emit(controller, {
      type: "response.content_part.added",
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: "reasoning_text", text: "" },
    });
    return state;
  };

  const ensureMessage = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (messageState) return messageState;
    const state: Extract<StreamItemState, { kind: "message" }> = {
      kind: "message",
      id: `msg_${itemSuffix(context.responseId)}_${nextOutputIndex}`,
      outputIndex: nextOutputIndex++,
      text: "",
    };
    messageState = state;
    orderedStates.push(state);
    emit(controller, {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: { id: state.id, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    emit(controller, {
      type: "response.content_part.added",
      item_id: state.id,
      output_index: state.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return state;
  };

  const ensureTool = (controller: TransformStreamDefaultController<Uint8Array>, call: any) => {
    let state = toolStates.get(call.id);
    if (state) return state;
    state = {
      kind: "function_call",
      id: `fc_${itemSuffix(context.responseId)}_${nextOutputIndex}`,
      outputIndex: nextOutputIndex++,
      callId: call.id,
      name: call.name,
      arguments: "",
    };
    toolStates.set(call.id, state);
    orderedStates.push(state);
    emit(controller, {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item: {
        id: state.id,
        type: "function_call",
        call_id: state.callId,
        name: state.name,
        arguments: "",
        status: "in_progress",
      },
    });
    return state;
  };

  const finalize = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (finalized) return;
    finalized = true;
    const result = currentResult();
    const { status } = responseStatus(result);
    const itemStatus = status === "completed" ? "completed" : "incomplete";

    for (const state of orderedStates) {
      if (state.kind === "reasoning") {
        emit(controller, {
          type: "response.reasoning_text.done",
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          text: state.text,
        });
        emit(controller, {
          type: "response.content_part.done",
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          part: { type: "reasoning_text", text: state.text },
        });
        emit(controller, {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item: { id: state.id, type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: state.text }], status: itemStatus },
        });
      } else if (state.kind === "message") {
        emit(controller, {
          type: "response.output_text.done",
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          text: state.text,
          logprobs: [],
        });
        emit(controller, {
          type: "response.content_part.done",
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: state.text, annotations: [] },
        });
        emit(controller, {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item: { id: state.id, type: "message", role: "assistant", status: itemStatus, content: [{ type: "output_text", text: state.text, annotations: [] }] },
        });
      } else {
        emit(controller, {
          type: "response.function_call_arguments.done",
          item_id: state.id,
          output_index: state.outputIndex,
          arguments: state.arguments,
          name: state.name,
        });
        emit(controller, {
          type: "response.output_item.done",
          output_index: state.outputIndex,
          item: { id: state.id, type: "function_call", call_id: state.callId, name: state.name, arguments: state.arguments, status: "completed" },
        });
      }
    }

    const response = encodeResponsesResult({ ...context, result });
    emit(controller, { type: status === "completed" ? "response.completed" : "response.incomplete", response });
  };

  return new TransformStream<CompletionStreamEvent, Uint8Array>({
    start(controller) {
      emit(controller, { type: "response.created", response: inProgressResponse() });
    },
    transform(event, controller) {
      if (event.type === "done") {
        finalize(controller);
        return;
      }
      const chunk = event.chunk;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;

      if (chunk.reasoningDelta) {
        const state = ensureReasoning(controller);
        state.text += chunk.reasoningDelta;
        emit(controller, {
          type: "response.reasoning_text.delta",
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          delta: chunk.reasoningDelta,
        });
      }
      if (chunk.textDelta) {
        const state = ensureMessage(controller);
        state.text += chunk.textDelta;
        emit(controller, {
          type: "response.output_text.delta",
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          delta: chunk.textDelta,
          logprobs: [],
        });
      }
      for (const call of chunk.toolCalls ?? []) {
        const state = ensureTool(controller, call);
        state.arguments += call.arguments;
        emit(controller, {
          type: "response.function_call_arguments.delta",
          item_id: state.id,
          output_index: state.outputIndex,
          delta: call.arguments,
        });
      }
    },
    flush(controller) {
      finalize(controller);
    },
  });
}
