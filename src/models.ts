import type { AntigravityAccount } from "./auth/types";

export interface SupportedModel {
  id: string;
  name: string;
  thinkingLevels: readonly string[];
  defaultThinkingLevel: string;
  recommended?: boolean;
}
export const ANTIGRAVITY_CLIENT_VERSION = "2.26.0";
export const GEMINI_CHAT_MODELS: readonly SupportedModel[] = [
  { id: "antigravity-gemini-3.8-flash", name: "Gemini 3.8 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "high", recommended: true },
  { id: "antigravity-gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
  { id: "antigravity-gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
  { id: "antigravity-gemini-3-flash", name: "Gemini 3 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
];
/** Stable proxy IDs; backend IDs are resolved in utils/transform.ts. */
export const SUPPORTED_MODELS: readonly SupportedModel[] = [
  ...GEMINI_CHAT_MODELS,
  { id: "antigravity-claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
  { id: "antigravity-claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
  { id: "antigravity-gpt-oss-120b", name: "GPT-OSS 120B", thinkingLevels: ["medium"], defaultThinkingLevel: "medium" }
] as const;

export const ANTIGRAVITY_MODEL_CATALOG = {
  clientVersion: ANTIGRAVITY_CLIENT_VERSION,
  chatModels: SUPPORTED_MODELS,
  removedModels: ["gemini-3-flash-agent", "gemini-3.5-flash-extra-low", "gemini-3.5-flash-low", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.1-pro", "gemini-pro-agent"],
  disabledModels: [],
  imageModels: [{ id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image (Nano Banana 2)" }],
} as const;

export function getUnavailableModelError(modelId: string): string | undefined {
  const id = normalizeModelId(modelId);
  if (id === "gemini-3-flash-agent" || /^gemini-3\.5-flash(?:$|-(?!lite(?:$|-)))/.test(id)) {
    return `Model '${modelId}' is retired upstream. Use antigravity-gemini-3.8-flash or antigravity-gemini-3.5-flash-lite from /v1/models.`;
  }
  if (ANTIGRAVITY_MODEL_CATALOG.removedModels.some(model => id === model || id.startsWith(`${model}-`))) {
    return `Model '${modelId}' is unavailable. Use antigravity-gemini-3.8-flash or another model from /v1/models.`;
  }
  if (id.endsWith("-disabled")) {
    return `Model '${modelId}' is disabled upstream. Choose an available model from /v1/models.`;
  }
}

/** Account discovery is authoritative; IDs here are the upstream routing IDs. */
export interface DiscoveredModel {
  id: string;
  name: string;
  supportsThinking?: boolean;
  maxOutputTokens?: number;
}

export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/^(openai|antigravity|custom_openai|litellm|google|models)\//, "")
    .replace(/^antigravity-/, "").replace(/^gemini-claude-/, "claude-");
}

export function modelBaseId(id: string): string {
  return normalizeModelId(id).replace(/-(?:thinking-)?(?:low|medium|high|tiered)$/, "").replace(/-thinking$/, "");
}

export function getModelFamilyName(name: string): string {
  const n = normalizeModelId(name).replace(/[ .]/g, "-");
  const claude = n.match(/claude-(sonnet|opus)-(\d+)-(\d+)/);
  if (claude) return `Claude ${claude[1] === "opus" ? "Opus" : "Sonnet"} ${claude[2]}.${claude[3]}`;
  // New Gemini generations may have their own pool; never merge them into Flash.
  const gemini = n.match(/gemini-(\d+)(?:-([a-z]+))?/);
  if (gemini && Number(gemini[1]) >= 4) {
    return `Gemini ${gemini[1]}${gemini[2] ? ` ${gemini[2][0]!.toUpperCase()}${gemini[2].slice(1)}` : ""}`;
  }
  if (n.includes("gemini")) return "Gemini Models";
  if (n.includes("claude")) return "Claude Models";
  if (n.includes("gpt-oss") && n.includes("120b")) return "GPT-OSS 120B";
  if (n.includes("gpt")) return "GPT Models";
  return "Other";
}

export function findAccountModel(account: AntigravityAccount, id: string, effort?: string): DiscoveredModel | undefined {
  const normalized = normalizeModelId(id);
  const models = account.availableModels || [];
  const exact = models.find(model => model.id === normalized);
  if (exact) return exact;
  const base = modelBaseId(id);
  const matches = models.filter(model => modelBaseId(model.id) === base);
  const tier = normalized.match(/-(low|medium|high)$/)?.[1] || effort || "high";
  return matches.find(model => model.id === `${base}-tiered`)
    || matches.find(model => model.id === `${base}-${tier}`)
    || matches.find(model => model.id === `${base}-thinking-${tier}`)
    || matches.find(model => model.id === base || model.id === `${base}-thinking`)
    || (!normalized.match(/-(low|medium|high)$/) && !effort ? matches.at(-1) : undefined);
}

export function getAccountModelQuotas(account: AntigravityAccount, id: string) {
  const base = modelBaseId(id);
  const quotas = account.quota || [];
  const resolved = findAccountModel(account, id)?.id || normalizeModelId(id);
  const routed = quotas.filter(q => (q.modelIds || (q.modelId ? [q.modelId] : [])).includes(resolved));
  if (routed.length) return routed;
  const exact = quotas.filter(q => (q.modelIds || (q.modelId ? [q.modelId] : [])).some(model => modelBaseId(model) === base));
  if (exact.length) return exact;
  // Legacy state did not always include IDs. Only use family matching for those rows.
  const family = getModelFamilyName(id);
  return quotas.filter(q => !q.modelId && !q.modelIds?.length && getModelFamilyName(q.groupName) === family);
}

export function accountSupportsModel(account: AntigravityAccount, id: string, effort?: string): boolean {
  const normalized = normalizeModelId(id);
  if (Object.entries(account.capabilities || {}).some(([key, supported]) => !supported && normalizeModelId(key) === normalized)) return false;
  if (account.availableModels) return !!findAccountModel(account, id, effort);
  // During migration, keep baseline routing and restrict special models to discovered accounts.
  return SUPPORTED_MODELS.some(model => modelBaseId(model.id) === modelBaseId(id))
    || /^gemini-2\./.test(normalized)
    || getAccountModelQuotas(account, id).length > 0;
}

function groupKey(name: string): string {
  return name.toLowerCase().replace(/\s*\((?:low|medium|high|thinking)\)$/i, "").replace(/[^a-z0-9]/g, "");
}

export function getAccountQuotaWindows(account: AntigravityAccount, id: string) {
  const family = getModelFamilyName(id);
  const quotas = getAccountModelQuotas(account, id);
  const names = quotas.flatMap(q => [q.limitName, q.groupName]).map(groupKey);
  const windows = account.quotaWindows || [];
  const specific = windows.filter(window => names.includes(groupKey(window.groupName)));
  if (specific.length) return specific;
  const familyWindows = windows.filter(window => groupKey(window.groupName) === groupKey(family));
  if (familyWindows.length) return familyWindows;
  // The upstream summary explicitly declares the common third-party pool.
  if (/^Claude |^GPT/.test(family)) return windows.filter(window => /claude.*gpt|gpt.*claude/i.test(window.groupName));
  return [];
}

export function getAvailableModelCatalog(accounts: AntigravityAccount[]): SupportedModel[] {
  const catalog = new Map(SUPPORTED_MODELS.map(model => [model.id, { ...model }]));
  for (const account of accounts) {
    if (account.disabled || account.challenge || !account.refreshToken) continue;
    for (const model of account.availableModels || []) {
      if (getUnavailableModelError(model.id) || /image/i.test(model.id) || SUPPORTED_MODELS.some(known => known.name === model.name)) continue;
      // Keep tier IDs as well as a convenient base alias for newly discovered models.
      const id = `antigravity-${model.id}`;
      if (!catalog.has(id) && !SUPPORTED_MODELS.some(known => modelBaseId(known.id) === modelBaseId(model.id))) {
        const tier = model.id.match(/-(low|medium|high)$/)?.[1];
        catalog.set(id, { id, name: model.name, thinkingLevels: tier ? [tier] : [], defaultThinkingLevel: tier || "" });
        if (tier) {
          const baseId = `antigravity-${modelBaseId(model.id)}`;
          const previous = catalog.get(baseId);
          const levels = [...new Set([...(previous?.thinkingLevels || []), tier])].sort((a, b) => ["low", "medium", "high"].indexOf(a) - ["low", "medium", "high"].indexOf(b));
          catalog.set(baseId, { id: baseId, name: model.name.replace(/\s*\((Low|Medium|High)\)$/i, ""), thinkingLevels: levels, defaultThinkingLevel: levels.at(-1)! });
        }
      }
    }
  }
  return [...catalog.values()];
}

export function getAccountModelFamily(account: AntigravityAccount, id: string): string {
  return getAccountModelQuotas(account, id)[0]?.familyName || getModelFamilyName(id);
}

export function updateQuotaFamilies(account: AntigravityAccount): void {
  for (const quota of account.quota || []) {
    if (!quota.modelId) continue;
    const windows = getAccountQuotaWindows(account, quota.modelId);
    const dedicated = windows.find(window => !/^(gemini models|claude and gpt models)$/i.test(window.groupName));
    quota.familyName = dedicated?.groupName || getModelFamilyName(quota.modelId);
  }
}

export function isModernGeminiModel(id: string): boolean {
  const generation = normalizeModelId(id).match(/^gemini-(\d+)/)?.[1];
  return generation !== undefined && Number(generation) >= 3;
}
