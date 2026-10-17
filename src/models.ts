export interface SupportedModel {
  id: string;
  name: string;
  thinkingLevels: readonly string[];
  defaultThinkingLevel: string;
  recommended?: boolean;
}

export const ANTIGRAVITY_CLIENT_VERSION = "2.24.0";
export const GEMINI_CHAT_MODELS: readonly SupportedModel[] = [
  { id: "antigravity-gemini-3.8-flash", name: "Gemini 3.8 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "high", recommended: true },
  { id: "antigravity-gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
  { id: "antigravity-gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
  { id: "antigravity-gemini-3-flash", name: "Gemini 3 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
];
export const ANTIGRAVITY_MODEL_CATALOG = {
  clientVersion: ANTIGRAVITY_CLIENT_VERSION,
  chatModels: GEMINI_CHAT_MODELS,
  removedModels: ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.1-pro", "gemini-pro-agent"],
  disabledModels: [{ id: "gemini-4-argon-disabled", name: "Gemini 4 Argon", reason: "上游标记为不可用。" }],
  imageModels: [{ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image (Nano Banana 2)" }],
} as const;

export function getUnavailableModelError(modelId: string): string | undefined {
  const id = modelId.trim().toLowerCase()
    .replace(/^(openai|antigravity|custom_openai|litellm|google)\//, "")
    .replace(/^antigravity-/, "");
  if (id === "gemini-3-flash-agent" || /^gemini-3\.5-flash(?:$|-(?!lite(?:$|-)))/.test(id)) {
    return `Model '${modelId}' is retired upstream. Use antigravity-gemini-3.8-flash or antigravity-gemini-3.5-flash-lite from /v1/models.`;
  }
  if (ANTIGRAVITY_MODEL_CATALOG.removedModels.some(model => id === model || id.startsWith(`${model}-`))) {
    return `Model '${modelId}' is unavailable. Use antigravity-gemini-3.8-flash or another model from /v1/models.`;
  }
  if (id === "gemini-4-argon" || id.startsWith("gemini-4-argon-")) {
    return `Gemini 4 Argon is currently unavailable. Choose an available model from /v1/models.`;
  }
}

/**
 * Stable, OpenAI-facing model catalog. Runtime model IDs are resolved in
 * utils/transform.ts because Antigravity's public and backend IDs can differ.
 */
export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  ...GEMINI_CHAT_MODELS,
  { id: "antigravity-claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
  { id: "antigravity-claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
  { id: "antigravity-gpt-oss-120b", name: "GPT-OSS 120B", thinkingLevels: ["medium"], defaultThinkingLevel: "medium" }
] as const;
