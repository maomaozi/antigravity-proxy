export type CompletionFinishReason = "stop" | "tool_calls" | "length" | "content_filter";

export interface CompletionUsage {
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningTokens: number;
  reasoningTokensReported: boolean;
  totalTokens: number;
}

export type CompletionContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

export interface CompletionToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
  thoughtSignature?: string;
}

export interface CompletionMessage {
  role: string;
  content?: string | CompletionContentPart[] | null;
  reasoningContent?: string;
  toolCalls?: CompletionToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface CompletionTool {
  name: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

export type CompletionResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema?: unknown; strict?: boolean };

export interface CompletionRequest {
  model: string;
  messages: CompletionMessage[];
  tools?: CompletionTool[];
  responseFormat?: CompletionResponseFormat;
  reasoningEffort?: string;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  temperature?: number;
  topP?: number;
  stream: boolean;
  promptCacheKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CompletionChunkToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
  thoughtSignature?: string;
}

export interface CompletionChunk {
  id: string;
  created: number;
  model: string;
  textDelta?: string;
  reasoningDelta?: string;
  toolCalls?: CompletionChunkToolCall[];
  finishReason?: CompletionFinishReason | null;
  usage?: CompletionUsage;
  /** Internal-only metadata used to preserve Gemini thought signatures. */
  thoughtSignature?: string;
  /** Internal-only reasoning text associated with thoughtSignature. */
  thoughtText?: string;
  /** Internal: false for usage-only upstream events with no candidate. */
  hasCandidate?: boolean;
}

export interface CompletionResult {
  text: string;
  reasoning: string;
  toolCalls: CompletionChunkToolCall[];
  finishReason: CompletionFinishReason;
  usage?: CompletionUsage;
}

export function accumulateCompletionChunks(chunks: Iterable<CompletionChunk>): CompletionResult {
  let text = "";
  let reasoning = "";
  const toolCalls: CompletionChunkToolCall[] = [];
  let finishReason: CompletionFinishReason = "stop";
  let usage: CompletionUsage | undefined;

  for (const chunk of chunks) {
    if (chunk.textDelta) text += chunk.textDelta;
    if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta;
    if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.usage) usage = chunk.usage;
  }

  return { text, reasoning, toolCalls, finishReason, usage };
}

export type CompletionStreamEvent =
  | { type: "chunk"; chunk: CompletionChunk }
  | { type: "done" };

export async function collectCompletionStream(
  stream: ReadableStream<CompletionStreamEvent>,
): Promise<CompletionResult> {
  let text = "";
  let reasoning = "";
  const toolCalls: CompletionChunkToolCall[] = [];
  let finishReason: CompletionFinishReason = "stop";
  let usage: CompletionUsage | undefined;
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.type === "done") continue;
    const chunk = value.chunk;
    if (chunk.textDelta) text += chunk.textDelta;
    if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta;
    if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
    if (chunk.finishReason) finishReason = chunk.finishReason;
    if (chunk.usage) usage = chunk.usage;
  }

  return { text, reasoning, toolCalls, finishReason, usage };
}
