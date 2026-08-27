import type {
  CompletionChunk,
  CompletionContentPart,
  CompletionMessage,
  CompletionRequest,
  CompletionResponseFormat,
  CompletionTool,
  CompletionToolCall,
  CompletionResult,
  CompletionStreamEvent,
} from "../../core/completion";

function adaptContent(content: any): string | CompletionContentPart[] | null | undefined {
  if (content == null || typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  return content.map((part: any) => {
    if (part?.type === "text") {
      return { type: "text", text: String(part.text ?? "") } as const;
    }
    if (part?.type === "image_url" && part.image_url?.url) {
      return { type: "image", url: String(part.image_url.url) } as const;
    }
    return null;
  }).filter((part): part is CompletionContentPart => part !== null);
}

function adaptToolCall(toolCall: any): CompletionToolCall {
  const explicitSignature = toolCall?.extra_content?.google?.thought_signature
    || toolCall?.providerOptions?.google?.thoughtSignature
    || toolCall?.provider_options?.google?.thought_signature;
  return {
    id: typeof toolCall?.id === "string" ? toolCall.id : "",
    name: toolCall?.function?.name || "",
    arguments: toolCall?.function?.arguments ?? "{}",
    ...(typeof explicitSignature === "string" && explicitSignature
      ? { thoughtSignature: explicitSignature }
      : {}),
  };
}

function adaptMessage(message: any): CompletionMessage {
  return {
    role: String(message?.role || ""),
    content: adaptContent(message?.content),
    reasoningContent: message?.thought || message?.reasoning_content,
    toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.map(adaptToolCall) : undefined,
    toolCallId: message?.tool_call_id,
    name: message?.name,
  };
}

function adaptTool(tool: any): CompletionTool {
  return {
    name: tool?.function?.name || "",
    description: tool?.function?.description,
    parameters: tool?.function?.parameters,
    strict: tool?.function?.strict,
  };
}

function adaptResponseFormat(responseFormat: any): CompletionResponseFormat | undefined {
  if (!responseFormat || typeof responseFormat !== "object") return undefined;
  if (responseFormat.type === "json_schema") {
    return {
      type: "json_schema",
      name: responseFormat.json_schema?.name,
      schema: responseFormat.json_schema?.schema,
      strict: responseFormat.json_schema?.strict,
    };
  }
  if (responseFormat.type === "json_object") return { type: "json_object" };
  if (responseFormat.type === "text") return { type: "text" };
  return undefined;
}

export function adaptChatCompletionRequest(body: any): CompletionRequest {
  const rawStop = body?.stop;
  const stopSequences = Array.isArray(rawStop)
    ? rawStop
    : (rawStop ? [rawStop] : undefined);
  const thinkingBudget = body?.thinking_budget
    ?? body?.thinking?.budget_tokens
    ?? body?.providerOptions?.thinkingBudget;

  return {
    model: typeof body?.model === "string" ? body.model : "",
    messages: Array.isArray(body?.messages) ? body.messages.map(adaptMessage) : [],
    tools: Array.isArray(body?.tools) ? body.tools.map(adaptTool) : undefined,
    responseFormat: adaptResponseFormat(body?.response_format),
    reasoningEffort: typeof body?.reasoning_effort === "string" ? body.reasoning_effort : undefined,
    thinkingBudget: typeof thinkingBudget === "number" ? thinkingBudget : undefined,
    maxOutputTokens: typeof body?.max_tokens === "number" ? body.max_tokens : undefined,
    stopSequences,
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    topP: typeof body?.top_p === "number" ? body.top_p : undefined,
    stream: body?.stream === true,
    promptCacheKey: typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key : undefined,
    metadata: body?.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
  };
}

function encodeUsage(usage: NonNullable<CompletionChunk["usage"]>): any {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
    ...(usage.reasoningTokensReported ? {
      completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    } : {}),
  };
}

export function encodeChatCompletionChunk(chunk: CompletionChunk): any {
  const delta: any = {};
  if (chunk.textDelta) delta.content = chunk.textDelta;
  if (chunk.reasoningDelta) delta.reasoning_content = chunk.reasoningDelta;
  if (chunk.toolCalls?.length) {
    delta.tool_calls = chunk.toolCalls.map(call => ({
      index: call.index,
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
      ...(call.thoughtSignature ? {
        extra_content: { google: { thought_signature: call.thoughtSignature } },
      } : {}),
    }));
  }

  return {
    id: chunk.id,
    object: "chat.completion.chunk",
    created: chunk.created,
    model: chunk.model,
    choices: chunk.hasCandidate === false ? [] : [{ index: 0, delta, finish_reason: chunk.finishReason ?? null }],
    usage: chunk.usage ? encodeUsage(chunk.usage) : undefined,
  };
}

export function createChatCompletionStreamEncoder(): TransformStream<CompletionStreamEvent, Uint8Array> {
  const encoder = new TextEncoder();
  return new TransformStream({
    transform(event, controller) {
      if (event.type === "done") {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(encodeChatCompletionChunk(event.chunk))}\n\n`));
    },
  });
}

export function encodeChatCompletionResult(
  requestId: string,
  model: string,
  result: CompletionResult,
  created: number = Math.floor(Date.now() / 1000),
): any {
  const toolCalls = result.toolCalls.map(call => ({
    index: call.index,
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
    ...(call.thoughtSignature ? {
      extra_content: { google: { thought_signature: call.thoughtSignature } },
    } : {}),
  }));

  return {
    id: requestId,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: result.text,
        reasoning_content: result.reasoning || undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: result.finishReason,
    }],
    usage: result.usage ? encodeUsage(result.usage) : undefined,
  };
}
