export interface SupportedModel {
  id: string;
  name: string;
  thinkingLevels: readonly string[];
  defaultThinkingLevel: string;
}

// Verified against fetchAvailableModels for the configured accounts. This is a
// dated snapshot, not a promise of availability for every subscription tier.
export const ANTIGRAVITY_CLIENT_VERSION = "2.23.0";
export const ANTIGRAVITY_MODEL_CATALOG = {
  clientVersion: ANTIGRAVITY_CLIENT_VERSION,
  verifiedAt: "2026-10-14",
  removedModels: ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.1-pro", "gemini-pro-agent"],
  disabledModels: [{ id: "gemini-4-argon-disabled", name: "Gemini 4 Argon" }],
  imageModels: [{ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image (Nano Banana 2)" }],
  notice: "Gemini 3.6、3.7 和 3.1 Pro 已从已核对账号的目录移除；Gemini 4 Argon 当前不可用。Gemini 3.5 作为兼容模型保留。实际可用性取决于账号。",
} as const;

export function getUnavailableModelError(modelId: string): string | undefined {
  const id = modelId.trim().toLowerCase()
    .replace(/^(openai|antigravity|custom_openai|litellm|google)\//, "")
    .replace(/^antigravity-/, "");
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
  { id: "antigravity-gemini-3.8-flash", name: "Gemini 3.8 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "high" },
  { id: "antigravity-gemini-3.5-flash", name: "Gemini 3.5 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" },
  { id: "antigravity-claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
  { id: "antigravity-claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
  { id: "antigravity-gpt-oss-120b", name: "GPT-OSS 120B", thinkingLevels: ["medium"], defaultThinkingLevel: "medium" }
] as const;
