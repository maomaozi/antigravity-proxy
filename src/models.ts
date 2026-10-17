export interface SupportedModel {
  id: string;
  name: string;
  thinkingLevels: readonly string[];
  defaultThinkingLevel: string;
  description?: string;
  recommended?: boolean;
}

// Verified against account discovery and real generation, not discovery alone.
// Upstream can retain retired models and return their notice with HTTP 200.
export const ANTIGRAVITY_CLIENT_VERSION = "2.24.0";
export const GEMINI_CHAT_MODELS: readonly SupportedModel[] = [
  { id: "antigravity-gemini-3.8-flash", name: "Gemini 3.8 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "high", recommended: true, description: "日常对话与工具调用的首选，默认 High。" },
  { id: "antigravity-gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low", description: "轻量聊天模型，与已停用的 3.5 Flash 不同。" },
  { id: "antigravity-gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low", description: "保留的轻量模型，可用于兼容现有工作流。" },
  { id: "antigravity-gemini-3-flash", name: "Gemini 3 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low", description: "旧版兼容模型，已通过实际生成验证。" },
];
export const ANTIGRAVITY_MODEL_CATALOG = {
  clientVersion: ANTIGRAVITY_CLIENT_VERSION,
  verifiedAt: "2026-10-17",
  verifiedAccountCount: 5,
  verification: "账号目录与实际生成均已核对；可用性仍取决于账号与上游容量。",
  chatModels: GEMINI_CHAT_MODELS,
  removedModels: ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.1-pro", "gemini-pro-agent"],
  retiredModels: [{ id: "antigravity-gemini-3.5-flash", name: "Gemini 3.5 Flash", reason: "Low / Medium / High 均返回停用提示，已从可选目录移除。", replacement: "antigravity-gemini-3.8-flash" }],
  disabledModels: [{ id: "gemini-4-argon-disabled", name: "Gemini 4 Argon", reason: "上游标记为不可用。" }],
  capacityLimitedModels: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reason: "实测返回 503 容量不足，暂不列为可选模型。" }],
  aliases: [{ ids: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking"], name: "Gemini 3.5 Flash Lite", replacement: "antigravity-gemini-3.5-flash-lite" }],
  imageModels: [{ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image (Nano Banana 2)" }],
  notice: "推荐 Gemini 3.8 Flash；3.5 Flash 已停用，3.5 Flash Lite 仍可用。旧别名不重复展示，图片模型在图片生成模式中选择。",
} as const;

export function getUnavailableModelError(modelId: string): string | undefined {
  const id = modelId.trim().toLowerCase()
    .replace(/^(openai|antigravity|custom_openai|litellm|google)\//, "")
    .replace(/^antigravity-/, "");
  if (id === "gemini-3-flash-agent" || /^gemini-3\.5-flash(?:$|-(?!lite(?:$|-)))/.test(id)) {
    return `Model '${modelId}' is retired upstream. Use antigravity-gemini-3.8-flash or antigravity-gemini-3.5-flash-lite from /v1/models.`;
  }
  if (ANTIGRAVITY_MODEL_CATALOG.removedModels.some(model => id === model || id.startsWith(`${model}-`))) {
    return `Model '${modelId}' was removed from the verified Antigravity account catalog on ${ANTIGRAVITY_MODEL_CATALOG.verifiedAt}. Use antigravity-gemini-3.8-flash or another model from /v1/models.`;
  }
  if (id === "gemini-4-argon" || id.startsWith("gemini-4-argon-")) {
    return `Gemini 4 Argon is disabled for the verified Antigravity accounts. Choose an available model from /v1/models.`;
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
