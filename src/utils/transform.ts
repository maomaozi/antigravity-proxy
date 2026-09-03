import { getSignature, cacheSignature } from "./cache";
import { cleanJSONSchemaForAntigravity } from "./schema";
import { getProxyConfig } from "../config/manager";
import type { CompletionChunk, CompletionFinishReason, CompletionRequest, CompletionStreamEvent, CompletionUsage } from "../core/completion";
import { adaptChatCompletionRequest, createChatCompletionStreamEncoder, encodeChatCompletionChunk } from "../api/openai/chat";

const TOOL_NAME_REMAP_CACHE = new Map<string, string>();
const SANITIZED_TOOL_NAME_CACHE = new Map<string, string>();
const MAX_GOOGLE_FUNCTION_NAME_LENGTH = 128;

interface ToolCallMetadata {
  callId: string;
  thoughtSignature?: string;
}

function decodeToolCallMetadata(toolCallId: unknown, explicitSignature?: unknown): ToolCallMetadata {
  const callId = typeof toolCallId === "string" ? toolCallId : "";
  const thoughtSignature = typeof explicitSignature === "string" && explicitSignature
    ? explicitSignature
    : undefined;

  if (!callId.startsWith("sig:")) {
    return { callId, thoughtSignature };
  }

  const signatureEnd = callId.indexOf(":", 4);
  if (signatureEnd === -1) {
    return { callId, thoughtSignature };
  }

  const encodedSignature = callId.slice(4, signatureEnd);
  const originalCallId = callId.slice(signatureEnd + 1);
  if (!encodedSignature || !originalCallId) {
    return { callId, thoughtSignature };
  }

  return {
    callId: originalCallId,
    thoughtSignature: thoughtSignature || encodedSignature
  };
}

function toolNameHash(name: string): string {
  return new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 8);
}

function sanitizeFunctionName(name: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/.test(name)) {
    return name;
  }

  const cached = TOOL_NAME_REMAP_CACHE.get(name);
  if (cached) return cached;

  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (/^[0-9]/.test(sanitized)) {
    sanitized = `fn_${sanitized}`;
  }
  if (!sanitized) {
    sanitized = "fn";
  }

  const suffix = `_${toolNameHash(name)}`;
  sanitized = `${sanitized.slice(0, MAX_GOOGLE_FUNCTION_NAME_LENGTH - suffix.length)}${suffix}`;

  const existingOriginal = SANITIZED_TOOL_NAME_CACHE.get(sanitized);
  if (existingOriginal && existingOriginal !== name) {
    const collisionSuffix = `_${toolNameHash(`${name}:${existingOriginal}`)}`;
    sanitized = `${sanitized.slice(0, MAX_GOOGLE_FUNCTION_NAME_LENGTH - collisionSuffix.length)}${collisionSuffix}`;
  }

  TOOL_NAME_REMAP_CACHE.set(name, sanitized);
  SANITIZED_TOOL_NAME_CACHE.set(sanitized, name);
  console.log(`[Sanitize] Renamed tool "${name}" → "${sanitized}"`);
  return sanitized;
}

export function getOriginalToolName(sanitizedName: string): string | undefined {
  return SANITIZED_TOOL_NAME_CACHE.get(sanitizedName);
}

export function validateCompletionRequestForGoogle(request: CompletionRequest): string | undefined {
  if (!request || typeof request !== "object") return "Request body must be a JSON object.";
  if (typeof request.model !== "string" || !request.model.trim()) return "model is required.";
  if (!Array.isArray(request.messages) || request.messages.length === 0) return "messages must be a non-empty array.";

  const messages = request.messages.filter(message => message?.role !== "system");
  const lastMessage = messages.at(-1);
  if (!lastMessage) return "At least one non-system message is required.";
  const isGemini3Request = request.model.toLowerCase().includes("gemini-3");
  if (isGemini3Request && (lastMessage.role === "assistant" || lastMessage.role === "model")) {
    return "Gemini 3 requests cannot end with a model/assistant turn; add a user or tool response.";
  }

  let pendingToolCalls = new Set<string>();
  for (const message of messages) {
    const toolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];

    if (message?.role !== "tool" && pendingToolCalls.size > 0) {
      return `Missing tool responses for call IDs: ${[...pendingToolCalls].join(", ")}.`;
    }

    if (toolCalls.length > 0) {
      pendingToolCalls = new Set<string>();
    }

    for (const toolCall of toolCalls) {
      const { callId } = decodeToolCallMetadata(toolCall?.id);
      if (!callId) return "Every tool call must have a non-empty id.";
      if (!toolCall?.name) return `Tool call ${callId} must have a function name.`;
      if (pendingToolCalls.has(callId)) return `Duplicate tool call id: ${callId}.`;
      pendingToolCalls.add(callId);
      if (typeof toolCall?.arguments === "string") {
        try {
          JSON.parse(toolCall.arguments || "{}");
        } catch {
          return `Tool call ${callId || "<unknown>"} contains invalid JSON arguments.`;
        }
      }
    }

    if (message?.role === "tool") {
      const { callId } = decodeToolCallMetadata(message.toolCallId);
      if (!callId || !pendingToolCalls.has(callId)) {
        return `Tool response ${callId || "<unknown>"} has no matching pending function call.`;
      }
      pendingToolCalls.delete(callId);
    }
  }

  return undefined;
}

export function validateOpenAIRequestForGoogle(openaiBody: any): string | undefined {
  if (!openaiBody || typeof openaiBody !== "object") return "Request body must be a JSON object.";
  return validateCompletionRequestForGoogle(adaptChatCompletionRequest(openaiBody));
}

const CLAUDE_MODEL_REGISTRY = [
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-v2-20241022",
    "claude-3-5-sonnet-20240620",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "claude-sonnet-4-6-thinking",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307"
];

function resolveModelId(modelId: string): string {
    let cleanId = modelId.toLowerCase().replace(/^(openai|antigravity|custom_openai|litellm|google)\//i, "");
    cleanId = cleanId.replace(/^antigravity-/i, "");
    cleanId = cleanId.replace(/^gemini-claude-/i, "claude-");

    if (cleanId.includes("claude")) {
        const exactMatch = CLAUDE_MODEL_REGISTRY.find(m => m === cleanId);
        if (exactMatch) return exactMatch;

        const baseId = cleanId.replace(/-(thinking|preview)(-(low|medium|high))?$/i, "");
        
        const fuzzyMatches = CLAUDE_MODEL_REGISTRY.filter(m => 
            m.startsWith(cleanId) || m.startsWith(baseId) || cleanId.startsWith(m)
        );

        if (fuzzyMatches.length > 0) {
            fuzzyMatches.sort((a, b) => b.localeCompare(a));
            return fuzzyMatches[0];
        }
    }

    return cleanId;
}

export function transformCompletionToGoogleBody(
  request: CompletionRequest,
  projectId: string, 
  isCli: boolean, 
  location: string, 
  sessionId?: string, 
  aggressive: boolean = false
): any {
  const proxyConfig = getProxyConfig();
  const rawModel = (request.model || "").toLowerCase();
  const resolvedModel = resolveModelId(request.model);
  let googleModel = resolvedModel;
  
  const tierMatch = rawModel.match(/-(low|medium|high)$/i);
  const thinkingTierMatch = rawModel.match(/-thinking-(low|medium|high)$/i);
  const reasoningEffort = typeof request.reasoningEffort === "string"
    ? request.reasoningEffort.toLowerCase()
    : undefined;
  const requestTier = reasoningEffort && /^(low|medium|high)$/.test(reasoningEffort)
    ? reasoningEffort
    : undefined;
  let extractedTier = thinkingTierMatch
    ? thinkingTierMatch[1]
    : (tierMatch ? tierMatch[1] : requestTier);

  // Stable proxy IDs hide Antigravity's changing runtime IDs. Some display
  // tiers intentionally map to unexpectedly named backend models.
  let hasCurrentModelRoute = false;
  const routeCurrentModel = (model: string, tier?: string) => {
    googleModel = model;
    extractedTier ||= tier;
    hasCurrentModelRoute = true;
  };

  const gemini38Match = resolvedModel.match(/^gemini-3\.8-flash(?:-(low|medium|high))?$/);
  const gemini37Match = resolvedModel.match(/^gemini-3\.7-flash(?:-(low|medium|high))?$/);
  const gemini36Match = resolvedModel.match(/^gemini-3\.6-flash(?:-(low|medium|high))?$/);
  const gemini35Match = resolvedModel.match(/^gemini-3\.5-flash(?:-(low|medium|high))?$/);
  const gemini31ProMatch = resolvedModel.match(/^gemini-3\.1-pro(?:-(low|high))?$/);

  if (gemini38Match) {
    routeCurrentModel("gemini-3.8-flash-tiered", gemini38Match[1] || "medium");
  } else if (gemini37Match) {
    routeCurrentModel("gemini-3.7-flash-tiered", gemini37Match[1] || "medium");
  } else if (gemini36Match) {
    const tier = gemini36Match[1] || "medium";
    routeCurrentModel(`gemini-3.6-flash-${tier}`, tier);
  } else if (gemini35Match) {
    const tier = gemini35Match[1] || "medium";
    const runtimeByTier: Record<string, string> = {
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent"
    };
    routeCurrentModel(runtimeByTier[tier], tier);
  } else if (gemini31ProMatch) {
    const tier = gemini31ProMatch[1] || "high";
    routeCurrentModel(tier === "low" ? "gemini-3.1-pro-low" : "gemini-pro-agent", tier);
  } else if (resolvedModel === "claude-sonnet-4-6-thinking") {
    routeCurrentModel("claude-sonnet-4-6");
  } else if (resolvedModel === "claude-opus-4-6-thinking") {
    routeCurrentModel("claude-opus-4-6-thinking");
  } else if (resolvedModel === "gpt-oss-120b") {
    routeCurrentModel("gpt-oss-120b-medium", "medium");
  }
  
  let baseModel = googleModel;
  if (thinkingTierMatch) {
      baseModel = googleModel.replace(thinkingTierMatch[0], "");
  } else if (tierMatch) {
      baseModel = googleModel.replace(tierMatch[0], "");
  }
  
  const previewMatch = baseModel.match(/-preview$/i);
  if (previewMatch) {
      baseModel = baseModel.replace(previewMatch[0], "");
  }

  // Force Claude model IDs to strip tier for the backend
        if (!hasCurrentModelRoute && googleModel.includes("claude")) {
            googleModel = baseModel;
            if (googleModel === "claude-opus-4-6") googleModel = "claude-opus-4-6-thinking";
            if (googleModel === "claude-sonnet-4-5") googleModel = "claude-sonnet-4-5-thinking";
        }

    const nativelySupported = [
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-thinking",
      "claude-sonnet-4-5", 
      "claude-sonnet-4-5-thinking", 
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
      "gemini-3.8-flash-tiered",
      "gemini-3.7-flash-tiered",
      "gemini-3.6-flash-medium",
      "gemini-3.5-flash-low",
      "gemini-pro-agent",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "gemini-3.1-pro",
      "gemini-3.1-pro-preview",
      "gemini-3-flash",
      "gemini-3-pro-high", 
      "gemini-3-pro-low",
      "gemini-3-pro",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-thinking",
      "gemini-3-pro-preview",
      "gemini-3-flash-preview"
  ];
  
  const isNative = (nativelySupported.includes(googleModel) || nativelySupported.includes(baseModel));

  if (!hasCurrentModelRoute && isCli) {
      if (!googleModel.includes("claude")) {
          // Standardize Gemini 3 CLI models to use -preview suffix
          if (googleModel.includes("gemini-3")) {
              googleModel = baseModel; // Strip tiers
              if (!googleModel.endsWith("-preview")) {
                  googleModel = `${googleModel}-preview`;
              }
          } else if (googleModel.includes("gpt")) {
              if (googleModel.includes("thinking")) {
                   googleModel = "gemini-2.0-flash-thinking-exp";
              } else {
                   googleModel = "gemini-2.0-pro-exp";
              }
          } else {
               googleModel = baseModel;
          }
       } else {
           googleModel = baseModel;
           if (googleModel === "claude-sonnet-4-5") googleModel = "claude-sonnet-4-5-thinking";
       }
   } else if (!hasCurrentModelRoute) {
       if (googleModel.endsWith("-preview")) {
           googleModel = googleModel.replace("-preview", "");
       }
       
       if (isNative) {
           if (baseModel.includes("gemini-3.1-pro")) {
               googleModel = `gemini-3.1-pro-${extractedTier || "high"}`;
           } else if (baseModel.includes("gemini-3-pro")) {
               // Respect extracted tier for Gemini 3 Pro, fallback to high
               googleModel = `gemini-3-pro-${extractedTier || "high"}`;
           } else if (baseModel.includes("gemini-3-flash")) {
               googleModel = "gemini-3-flash";
           } else {
               googleModel = baseModel;
           }

             if (googleModel === "claude-opus-4-6" || googleModel === "antigravity-claude-opus-4-6") {
                 googleModel = "claude-opus-4-6-thinking";
             }
           if (googleModel === "claude-sonnet-4-5" || googleModel === "antigravity-claude-sonnet-4-5") {
               googleModel = "claude-sonnet-4-5-thinking";
           }
       }
  }

  // Extract system instruction (like plugin)
  const systemMessage = request.messages.find(m => m.role === "system");
  const otherMessages = request.messages.filter(m => m.role !== "system");

  // OpenAI-compatible clients such as OpenCode omit `name` from role=tool
  // messages. Recover it from the preceding assistant tool call using the
  // original Google call ID so FunctionResponse.name matches FunctionCall.name.
  const toolCallNames = new Map<string, string>();
  for (const msg of otherMessages) {
    for (const toolCall of msg.toolCalls || []) {
      if (!toolCall.name) continue;
      const { callId } = decodeToolCallMetadata(toolCall.id);
      const name = proxyConfig.features.sanitizeToolNames
        ? sanitizeFunctionName(toolCall.name)
        : toolCall.name;
      if (callId) toolCallNames.set(callId, name);
    }
  }

  const toInlineData = (url: string) => {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) return undefined;
    return { inlineData: { mimeType: match[1], data: match[2] } };
  };

  const toFunctionResponsePart = (msg: any) => {
    const contentParts = Array.isArray(msg.content) ? msg.content : undefined;
    const textContent = contentParts
      ? contentParts.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("")
      : msg.content;

    let responseObj;
    try {
      responseObj = typeof textContent === "string" ? JSON.parse(textContent) : textContent;
    } catch {
      responseObj = textContent;
    }

    if (typeof responseObj !== "object" || responseObj === null || Array.isArray(responseObj)) {
      responseObj = { result: responseObj ?? "" };
    }

    const mediaParts = contentParts
      ? contentParts
          .filter((part: any) => part?.type === "image" && typeof part.url === "string")
          .map((part: any) => toInlineData(part.url))
          .filter(Boolean)
      : [];

    const { callId } = decodeToolCallMetadata(msg.toolCallId);
    // The name is part of Google's correlation contract. Prefer the name of
    // the matching call even when an OpenAI client sends a stale/wrong name.
    const responseName = toolCallNames.get(callId) || msg.name || "function_result";
    return {
      functionResponse: {
        ...(callId ? { id: callId } : {}),
        name: proxyConfig.features.sanitizeToolNames
          ? sanitizeFunctionName(responseName)
          : responseName,
        response: responseObj,
        ...(mediaParts.length ? { parts: mediaParts } : {}),
      }
    };
  };

  const contents: any[] = [];
  for (let messageIndex = 0; messageIndex < otherMessages.length; messageIndex++) {
    const msg = otherMessages[messageIndex];

    if (msg.role === "tool") {
      const parts = [];
      while (messageIndex < otherMessages.length && otherMessages[messageIndex].role === "tool") {
        parts.push(toFunctionResponsePart(otherMessages[messageIndex]));
        messageIndex++;
      }
      messageIndex--;
      contents.push({ role: "user", parts });
      continue;
    }

    const parts: any[] = [];
    if ((msg.role === "assistant" || msg.role === "model") && sessionId) {
      const thoughtText = msg.reasoningContent;
      if (thoughtText) {
        const sig = getSignature(sessionId, thoughtText);
        if (sig) {
          parts.push({ thought: true, text: thoughtText, thoughtSignature: sig });
        } else if (proxyConfig.features.keepThinking) {
          parts.push({ thought: true, text: thoughtText });
        }
      }
    }

    if (msg.content) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            parts.push({ text: part.text });
           } else if (part.type === "image" && part.url) {
            const inlineData = toInlineData(part.url);
            if (inlineData) parts.push(inlineData);
          }
        }
      } else {
        parts.push({ text: msg.content });
      }
    }

    for (const tc of msg.toolCalls || []) {
      const explicitSignature = tc.thoughtSignature;
      const { callId, thoughtSignature } = decodeToolCallMetadata(tc.id, explicitSignature);
      const funcPart: any = {
        functionCall: {
          ...(callId ? { id: callId } : {}),
          name: proxyConfig.features.sanitizeToolNames
            ? sanitizeFunctionName(tc.name)
            : tc.name,
          args: typeof tc.arguments === "string"
            ? JSON.parse(tc.arguments || "{}")
            : (tc.arguments || {})
        }
      };

      if (thoughtSignature) {
        funcPart.thoughtSignature = thoughtSignature;
      }
      parts.push(funcPart);
    }

    if (parts.length === 0) {
      parts.push({ text: " " });
    }

    contents.push({
      role: (msg.role === "assistant" || msg.role === "model") ? "model" : "user",
      parts
    });
  }

  const isThinkingModel = rawModel.includes("-thinking") ||
                          rawModel.includes("gemini-3.8-flash") ||
                          rawModel.includes("gemini-3.7-flash") ||
                          rawModel.includes("gemini-3.6-flash") ||
                          rawModel.includes("gemini-3.5-flash") ||
                          rawModel.includes("gemini-3.1-pro");
  const isGemini3ProtocolModel = rawModel.includes("gemini-3");
  let thinkingBudget = request.thinkingBudget;

  if (!thinkingBudget && isThinkingModel) {
      if (extractedTier === "low") thinkingBudget = 8192;
      else if (extractedTier === "medium") thinkingBudget = 16000;
      else if (extractedTier === "high") thinkingBudget = 32768;
      else thinkingBudget = 16000;
  }
  
  const systemInstruction = systemMessage
    ? { parts: [{ text: systemMessage.content }] }
    : undefined;

  const requestedMaxTokens = Number(request.maxOutputTokens);
  const defaultMaxOutputTokens = isThinkingModel ? 64000 : 4096;
  const normalizedMaxOutputTokens = Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
    ? Math.trunc(requestedMaxTokens)
    : defaultMaxOutputTokens;
  const modelOutputLimit = isGemini3ProtocolModel
    ? 65536
    : (googleModel.includes("claude") ? 64000 : (googleModel.includes("gpt-oss") ? 32768 : undefined));
  const maxOutputTokens = modelOutputLimit
    ? Math.min(normalizedMaxOutputTokens, modelOutputLimit)
    : normalizedMaxOutputTokens;

  const generationConfig: any = {
    maxOutputTokens,
    stopSequences: request.stopSequences
  };

  // Gemini 3.5+ rejects or ignores legacy sampling parameters and candidateCount.
  if (!isGemini3ProtocolModel) {
    generationConfig.temperature = request.temperature ?? 0.7;
    generationConfig.topP = request.topP ?? 0.95;
    generationConfig.candidateCount = 1;
  }

  const googleRequest: any = {
    contents,
    systemInstruction,
    generationConfig,
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: process.env.SAFETY_THRESHOLD || "BLOCK_NONE" }
    ],
    sessionId: sessionId || crypto.randomUUID()
  };

  const responseFormat = request.responseFormat;
  const supportsStructuredResponse = !googleModel.includes("gpt");
  let hasStructuredResponse = false;
  if (supportsStructuredResponse && responseFormat?.type === "json_object") {
    googleRequest.generationConfig.responseMimeType = "application/json";
    if (googleModel.includes("claude")) {
      // Claude's Antigravity structured-output path requires a schema. An
      // unconstrained object schema preserves json_object semantics without
      // modifying the user's prompt. This must bypass the Google Schema
      // cleaner because additionalProperties is meaningful to Claude's
      // JSON-Schema-backed tool-use path but is not a Google Schema field.
      googleRequest.generationConfig.responseSchema = {
        type: "OBJECT",
        additionalProperties: true,
      };
      hasStructuredResponse = true;
    }
  } else if (supportsStructuredResponse && responseFormat?.type === "json_schema") {
    const responseSchema = responseFormat.schema;
    if (responseSchema && typeof responseSchema === "object" && !Array.isArray(responseSchema)) {
      googleRequest.generationConfig.responseMimeType = "application/json";
      googleRequest.generationConfig.responseSchema = cleanJSONSchemaForAntigravity(responseSchema, aggressive);
      googleRequest.generationConfig.responseSchema.title =
        responseFormat.name?.trim() || "json_schema";
      hasStructuredResponse = true;
    }
  }

  const structuredClaudeResponse = hasStructuredResponse && googleModel.includes("claude");
  if ((isThinkingModel || googleModel.includes("gemini-3")) && !structuredClaudeResponse) {
    googleRequest.generationConfig.thinkingConfig = isGemini3ProtocolModel
      ? {
          includeThoughts: true,
          thinkingLevel: extractedTier || "low"
        }
      : {
          includeThoughts: true,
          thinkingBudget: thinkingBudget || 16000
        };
  }

  if (request.tools) {
    const sanitize = proxyConfig.features.sanitizeToolNames;
    googleRequest.tools = [{
      functionDeclarations: request.tools.map(t => {
        const cleanParams = cleanJSONSchemaForAntigravity(t.parameters || { type: "object", properties: {} }, aggressive);
        
        let funcName = t.name;
        if (sanitize) {
          funcName = sanitizeFunctionName(funcName);
        }

        let description = t.description || "";
        const paramNames = Object.keys(cleanParams.properties || {});
        if (paramNames.length > 0) {
          description += ` [Parameters: ${paramNames.join(", ")}]`;
        }

        const hasParameterSchema = paramNames.length > 0
          || Object.keys(cleanParams).some(key => key !== "type" && key !== "properties");

        return {
          name: funcName,
          description: description.trim() || `Call ${funcName}.`,
          ...(hasParameterSchema ? { parameters: cleanParams } : {})
        };
      })
    }];
    
    if (googleModel.includes("claude")) {
        googleRequest.toolConfig = {
            functionCallingConfig: { mode: "VALIDATED" }
        };
    }
  }

  const isGeminiModel = googleModel.includes("gemini");
  // Antigravity's current v1internal path rejects request-scoped Google Search
  // when it is mixed with client-visible function declarations, even though
  // public GenerateContent supports that combination. Codex sends web_search
  // alongside its function/namespace tools by default, so accept the hosted
  // declaration but only map it to native googleSearch when no function tools
  // are present. Global googleSearchGrounding keeps its existing behavior.
  const requestScopedGoogleSearch = request.webSearch && !request.tools?.length;
  if (isGeminiModel && (proxyConfig.features.googleSearchGrounding || requestScopedGoogleSearch)) {
    // Gemini 2.0+ uses googleSearch. googleSearchRetrieval is the legacy
    // pre-2.0 field and is rejected by current Gemini 3 models.
    const groundingTool: any = { googleSearch: {} };
    if (!googleRequest.tools) {
      googleRequest.tools = [];
    }
    googleRequest.tools.push(groundingTool);
  }

  return {
    project: projectId,
    model: googleModel,
    userAgent: "antigravity",
    requestId: `agent-${crypto.randomUUID()}`,
    requestType: "agent",
    request: googleRequest
  };
}

export function transformToGoogleBody(
  openaiBody: any,
  projectId: string,
  isCli: boolean,
  location: string,
  sessionId?: string,
  aggressive: boolean = false,
): any {
  return transformCompletionToGoogleBody(
    adaptChatCompletionRequest(openaiBody),
    projectId,
    isCli,
    location,
    sessionId,
    aggressive,
  );
}

export type UpstreamTokenUsage = CompletionUsage;

function usageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function optionalUsageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

export function normalizeUpstreamTokenUsage(metadata: any): UpstreamTokenUsage | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  return {
    inputTokens: usageCount(metadata.promptTokenCount),
    cachedInputTokens: optionalUsageCount(metadata.cachedContentTokenCount),
    outputTokens: usageCount(metadata.candidatesTokenCount),
    reasoningTokens: usageCount(metadata.thoughtsTokenCount),
    reasoningTokensReported: typeof metadata.thoughtsTokenCount === "number",
    totalTokens: usageCount(metadata.totalTokenCount),
  };
}

export function toOpenAIUsage(usage: UpstreamTokenUsage): any {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedInputTokens,
    },
    ...(usage.reasoningTokensReported ? {
      completion_tokens_details: {
        reasoning_tokens: usage.reasoningTokens,
      }
    } : {}),
  };
}

export function transformGoogleEventToCompletionChunk(
  googleData: any,
  model: string,
  requestId?: string,
  hasPriorToolCalls: boolean = false,
): CompletionChunk | null {
  const data = googleData.response || googleData;
  const requestIdActual = requestId || "chatcmpl-" + Math.random().toString(36).substring(7);
  const tokenUsage = normalizeUpstreamTokenUsage(data.usageMetadata);
  const created = Math.floor(Date.now() / 1000);

  if (!data.candidates || data.candidates.length === 0) {
    if (tokenUsage) {
      return {
        id: requestIdActual,
        created,
        model,
        usage: tokenUsage,
        hasCandidate: false,
      } as CompletionChunk;
    }
    return null;
  }

  const candidate = data.candidates[0];
  const parts = candidate.content?.parts || [];
  const finishReason = candidate.finishReason;

  if (parts.length === 0 && !finishReason && !tokenUsage) return null;

  let textDelta = "";
  let reasoningDelta = "";
  const toolCalls: NonNullable<CompletionChunk["toolCalls"]> = [];
  let extractedSignature: string | undefined;
  let extractedThought: string | undefined;

  for (const part of parts) {
    const isThought = part.thought || part.thoughtText || part.type === "thinking";

    if (part.text) {
      let cleanText = part.text;
      if (cleanText.includes("thoughtSignature:")) {
        cleanText = cleanText.replace(/thoughtSignature:[a-zA-Z0-9\-_]+/g, "").trim();
      }

      if (cleanText) {
        if (isThought) {
          reasoningDelta += cleanText;
          extractedThought = (extractedThought || "") + cleanText;
        } else {
          textDelta += cleanText;
        }
      }
    }

    if (isThought && typeof isThought === "string") {
      reasoningDelta += isThought;
      extractedThought = (extractedThought || "") + isThought;
    }

    if (part.thoughtSignature || part.thought_signature || part.signature) {
      extractedSignature = part.thoughtSignature || part.thought_signature || part.signature;
    }

    if (part.functionCall || part.function_call) {
      const call = part.functionCall || part.function_call;
      // Gemini 3 parallel calls carry a signature only on the first function
      // call part. Never inherit it onto later calls in the same response.
      const sig = part.thoughtSignature || part.thought_signature || part.signature || "";
      const rawId = call.id || call.callId || call.call_id || "call_" + Math.random().toString(36).substring(7);
      const callId = (sig && !rawId.startsWith("sig:")) ? `sig:${sig}:${rawId}` : rawId;
      const funcName = getOriginalToolName(call.name) || call.name;

      toolCalls.push({
        index: toolCalls.length,
        id: callId,
        name: funcName,
        arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args || {}),
        ...(sig ? { thoughtSignature: sig } : {}),
      });
      if (sig) extractedSignature = sig;
    }
  }

  let completionFinishReason: CompletionFinishReason | null = null;
  if (finishReason) {
    if (toolCalls.length > 0 || hasPriorToolCalls) {
      completionFinishReason = "tool_calls";
    } else if (finishReason === "STOP") {
      completionFinishReason = "stop";
    } else if (finishReason === "MAX_TOKENS") {
      completionFinishReason = "length";
    } else if (finishReason === "SAFETY") {
      completionFinishReason = "content_filter";
    } else if (finishReason === "MALFORMED_FUNCTION_CALL") {
      completionFinishReason = "tool_calls";
    } else {
      completionFinishReason = "stop";
    }
  }

  return {
    id: requestIdActual,
    created,
    model,
    ...(textDelta ? { textDelta } : {}),
    ...(reasoningDelta ? { reasoningDelta } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    finishReason: completionFinishReason,
    ...(tokenUsage ? { usage: tokenUsage } : {}),
    ...(extractedSignature ? { thoughtSignature: extractedSignature } : {}),
    ...(extractedThought ? { thoughtText: extractedThought } : {}),
  };
}

export function transformGoogleEventToOpenAI(
  googleData: any,
  model: string,
  requestId?: string,
  hasPriorToolCalls: boolean = false,
): any {
  const chunk = transformGoogleEventToCompletionChunk(googleData, model, requestId, hasPriorToolCalls);
  if (!chunk) return null;

  const event = encodeChatCompletionChunk(chunk);
  return {
    ...event,
    _signature: chunk.thoughtSignature,
    _thought: chunk.thoughtText,
    _tokenUsage: chunk.usage,
  };
}

export function createCompletionStreamTransformer(
  model: string,
  requestId: string,
  hasPriorToolCalls: boolean,
  sessionId?: string,
  onUsage?: (usage: UpstreamTokenUsage) => void,
): TransformStream<Uint8Array, CompletionStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let currentHasPriorToolCalls = hasPriorToolCalls;
  let accumulatedThought = "";
  let nextToolCallIndex = 0;
  const toolCallIndexes = new Map<string, number>();

  const emitUsage = (usage: UpstreamTokenUsage | undefined) => {
    if (!usage || !onUsage) return;
    try {
      onUsage(usage);
    } catch (error) {
      console.warn("[Usage] Failed to process upstream token metadata:", error);
    }
  };

  const rememberThoughtSignature = (chunk: CompletionChunk) => {
    if (chunk.thoughtText) accumulatedThought += chunk.thoughtText;

    // Tool-call signatures belong to the functionCall part and are carried in
    // the synthetic call ID/metadata. Only cache signatures for thought text.
    const hasToolCalls = Boolean(chunk.toolCalls?.length);
    if (sessionId && chunk.thoughtSignature && accumulatedThought && !hasToolCalls) {
      cacheSignature(sessionId, accumulatedThought, chunk.thoughtSignature);
      console.log(`[Cache] Signature cached for conversation ${sessionId}`);
    }
  };

  const normalizeToolCallIndexes = (chunk: CompletionChunk) => {
    if (!chunk.toolCalls) return;
    for (const toolCall of chunk.toolCalls) {
      const key = toolCall.id || `anonymous:${nextToolCallIndex}`;
      let index = toolCallIndexes.get(key);
      if (index === undefined) {
        index = nextToolCallIndex++;
        toolCallIndexes.set(key, index);
      }
      toolCall.index = index;
    }
  };

  const processData = (dataStr: string, controller: TransformStreamDefaultController<CompletionStreamEvent>) => {
    if (dataStr === "[DONE]") {
      controller.enqueue({ type: "done" });
      return;
    }

    try {
      const googleEvent = JSON.parse(dataStr);
      const chunk = transformGoogleEventToCompletionChunk(
        googleEvent,
        model,
        requestId,
        currentHasPriorToolCalls,
      );
      if (!chunk) return;

      normalizeToolCallIndexes(chunk);
      emitUsage(chunk.usage);
      rememberThoughtSignature(chunk);

      const hasMeaningfulContent = Boolean(
        chunk.textDelta
        || chunk.reasoningDelta
        || chunk.toolCalls?.length
        || chunk.finishReason
        || chunk.usage,
      );
      if (!hasMeaningfulContent) return;

      if (chunk.toolCalls?.length) currentHasPriorToolCalls = true;
      controller.enqueue({ type: "chunk", chunk });
    } catch (e) {
      console.warn("[Stream] Failed to parse SSE line:", e);
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;
        processData(trimmedLine.slice(6), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data: ")) {
        processData(trimmed.slice(6), controller);
      }
    },
  });
}

export function createOpenAIStreamTransformer(
  model: string,
  requestId: string,
  hasPriorToolCalls: boolean,
  sessionId?: string,
  onUsage?: (usage: UpstreamTokenUsage) => void,
): ReadableWritablePair<Uint8Array, Uint8Array> {
  const canonical = createCompletionStreamTransformer(
    model,
    requestId,
    hasPriorToolCalls,
    sessionId,
    onUsage,
  );
  return {
    writable: canonical.writable,
    readable: canonical.readable.pipeThrough(createChatCompletionStreamEncoder()),
  };
}
