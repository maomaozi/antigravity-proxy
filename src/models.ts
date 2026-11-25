import type { AntigravityAccount } from "./auth/types";
import { getProxyConfig } from "./config/manager";

export interface SupportedModel {
  id: string;
  name: string;
  thinkingLevels: readonly string[];
  defaultThinkingLevel: string;
  recommended?: boolean;
}
export const ANTIGRAVITY_CLIENT_VERSION = "2.31.2";
// Official 2.31.2 Linux ARM language_server build, verified against native requests.
export const ANTIGRAVITY_CLIENT_BUILD = "1019359392";
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
  modelEnum?: string;
  thinkingLevel?: number;
}

export function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/^(openai|antigravity|custom_openai|litellm|google|models)\//, "")
    .replace(/^antigravity-/, "").replace(/^gemini-claude-/, "claude-");
}

export function modelBaseId(id: string): string {
  return normalizeModelId(id).replace(/-(?:thinking-)?(?:low|medium|high|xhigh|tiered)$/, "").replace(/-thinking$/, "");
}

export function getModelMetadataOverride(id: string) {
  const overrides = getProxyConfig().models.overrides || {};
  return overrides[normalizeModelId(id)] || overrides[modelBaseId(id)];
}

export function getModelReasoningError(id: string, effort?: string): string | undefined {
  const levels = getModelMetadataOverride(id)?.thinkingLevels;
  const selected = normalizeModelId(id).match(/-(low|medium|high|xhigh)$/)?.[1] || effort?.trim().toLowerCase();
  if (levels && selected && !levels.includes(selected)) {
    return `Model '${id}' does not support reasoning effort '${selected}'. Supported levels: ${levels.join(', ')}.`;
  }
}

export function getModelFamilyName(name: string): string {
  const configuredPool = getModelMetadataOverride(name)?.quotaPool;
  if (configuredPool) return configuredPool;
  const n = normalizeModelId(name).replace(/[ .]/g, "-");
  if (/^gemini-4-hydrogen(?:-|$)/.test(n)) return "Gemini Models";
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
  const requestedTier = normalized.match(/-(low|medium|high|xhigh)$/)?.[1];
  const tier = requestedTier || effort || "high";
  const matchingTier = matches.find(model => model.id === `${base}-tiered`)
    || matches.find(model => model.id === `${base}-${tier}`)
    || matches.find(model => model.id === `${base}-thinking-${tier}`)
    || matches.find(model => model.id === base || model.id === `${base}-thinking`)
    || (!requestedTier && !effort ? matches.at(-1) : undefined);
  if (matchingTier) return matchingTier;
  const fallbackId = getModelMetadataOverride(id)?.fallbackModelId;
  return fallbackId ? models.find(model => model.id === fallbackId) : undefined;
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
  return name.toLowerCase().replace(/\s*\((?:low|medium|high|xhigh|thinking)\)$/i, "").replace(/[^a-z0-9]/g, "");
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
  const fallbackPool = getModelMetadataOverride(id)?.fallbackQuotaPool;
  if (fallbackPool) return windows.filter(window => groupKey(window.groupName) === groupKey(fallbackPool));
  // The upstream summary explicitly declares the common third-party pool.
  if (/^Claude |^GPT/.test(family)) return windows.filter(window => /claude.*gpt|gpt.*claude/i.test(window.groupName));
  return [];
}

export function isAccountTosSuspended(account: AntigravityAccount): boolean {
  return account.suspension?.reason === "tos_violation";
}

export function getAvailableModelCatalog(accounts: AntigravityAccount[]): SupportedModel[] {
  const catalog = new Map(SUPPORTED_MODELS.map(model => [model.id, { ...model }]));
  for (const account of accounts) {
    if (account.disabled || account.challenge || !account.refreshToken || isAccountTosSuspended(account)) continue;
    for (const model of account.availableModels || []) {
      if (isAccountPoolSuspended(account, model.id)) continue;
      if (getUnavailableModelError(model.id) || /image/i.test(model.id) || SUPPORTED_MODELS.some(known => known.name === model.name)) continue;
      // Keep tier IDs as well as a convenient base alias for newly discovered models.
      const id = `antigravity-${model.id}`;
      if (!catalog.has(id) && !SUPPORTED_MODELS.some(known => modelBaseId(known.id) === modelBaseId(model.id))) {
        const tier = model.id.match(/-(low|medium|high|xhigh)$/)?.[1];
        const fixedLevel = model.thinkingLevel === 100 ? "xhigh" : ({ 1: "low", 2: "medium", 3: "high" } as Record<number, string>)[model.thinkingLevel || 0];
        const level = tier || fixedLevel || "";
        catalog.set(id, { id, name: model.name, thinkingLevels: level ? [level] : [], defaultThinkingLevel: level });
        if (tier) {
          const baseId = `antigravity-${modelBaseId(model.id)}`;
          const previous = catalog.get(baseId);
          const levels = [...new Set([...(previous?.thinkingLevels || []), tier])].sort((a, b) => ["low", "medium", "high", "xhigh"].indexOf(a) - ["low", "medium", "high", "xhigh"].indexOf(b));
          catalog.set(baseId, { id: baseId, name: model.name.replace(/\s*\((Low|Medium|High|XHigh)\)$/i, ""), thinkingLevels: levels, defaultThinkingLevel: levels.includes("high") ? "high" : levels.at(-1)! });
        }
      }
    }
  }
  // Enrich discovered entries only; overrides never advertise undiscovered models.
  return [...catalog.values()].map(model => {
    const override = getModelMetadataOverride(model.id);
    return override ? {
      ...model,
      name: override.name ?? model.name,
      thinkingLevels: override.thinkingLevels ?? model.thinkingLevels,
      defaultThinkingLevel: override.defaultThinkingLevel ?? model.defaultThinkingLevel,
    } : model;
  });
}

export function getAccountModelFamily(account: AntigravityAccount, id: string): string {
  const configuredPool = getModelMetadataOverride(id)?.quotaPool;
  if (configuredPool) return getAccountQuotaWindows(account, id)[0]?.groupName || configuredPool;
  return getAccountModelQuotas(account, id)[0]?.familyName || getModelFamilyName(id);
}

/** Use the pool declared by the upstream summary, including dedicated pools. */
export function getAccountModelPool(account: AntigravityAccount, id: string): string {
  const windows = getAccountQuotaWindows(account, id);
  if (windows.length) return windows[0]!.groupName;
  if (/image/i.test(id)) return modelBaseId(id);
  const family = getAccountModelFamily(account, id);
  return /^Claude |^GPT/.test(family) ? "Claude and GPT models" : family === "Other" ? modelBaseId(id) : family;
}

export function isAccountPoolSuspended(account: AntigravityAccount, id: string, now = Date.now()): boolean {
  if (isAccountTosSuspended(account)) return true;
  const suspension = account.poolSuspensions?.[getAccountModelPool(account, id)];
  if (!suspension) return false;
  if (suspension.reason === "tos_violation" || suspension.permanent) return true;
  return suspension.retryAt > now;
}

function normalizeDisplayToken(value: string): string {
  return normalizeModelId(value).replace(/[ _]/g, "-");
}

function matchesDisplayPatterns(values: string[], patterns?: string[]): boolean {
  if (!patterns?.length) return false;
  return patterns.some(pattern => {
    try {
      const regex = new RegExp(pattern, "i");
      return values.some(value => regex.test(value));
    } catch {
      return false;
    }
  });
}

function isDisplayModelVisible(id: string, visibility?: { showPatterns?: string[]; hidePatterns?: string[] }): boolean {
  const token = normalizeDisplayToken(id);
  if (matchesDisplayPatterns([token], visibility?.showPatterns)) return true;
  return !matchesDisplayPatterns([token], visibility?.hidePatterns);
}

function getDisplayVisibleQuotaItems(
  account: AntigravityAccount,
  visibility?: { showPatterns?: string[]; hidePatterns?: string[] },
): Array<{ id: string; groupName: string; limitName?: string; familyName?: string }> {
  const items: Array<{ id: string; groupName: string; limitName?: string; familyName?: string }> = [];
  for (const quota of account.quota || []) {
    const ids = quota.modelIds?.length ? quota.modelIds : quota.modelId ? [quota.modelId] : [];
    if (ids.length) {
      for (const id of ids) {
        if (isDisplayModelVisible(id, visibility)) {
          items.push({ id, groupName: quota.groupName, limitName: quota.limitName, familyName: quota.familyName });
        }
      }
    } else if (isDisplayModelVisible(quota.groupName, visibility)) {
      items.push({ id: quota.groupName, groupName: quota.groupName, limitName: quota.limitName, familyName: quota.familyName });
    }
  }
  return items;
}

function resolveDisplayQuotaPoolForItem(
  account: AntigravityAccount,
  item: { id: string; groupName?: string; limitName?: string; familyName?: string },
  poolRules?: Array<{ patterns: string[]; pools: string[]; preferDeclaredPool?: boolean }>,
): string {
  const windows = account.quotaWindows || [];
  const names = [item.limitName, item.groupName].filter((v): v is string => Boolean(v)).map(groupKey);
  const specific = windows.find(window => names.includes(groupKey(window.groupName)));
  if (specific) return specific.groupName;
  const declared = item.familyName
    ? windows.find(window => groupKey(window.groupName) === groupKey(item.familyName!))
    : undefined;
  const token = normalizeDisplayToken(item.id);
  for (const rule of poolRules || []) {
    if (!matchesDisplayPatterns([token], rule.patterns)) continue;
    if (rule.preferDeclaredPool && declared) return declared.groupName;
    for (const pool of rule.pools) {
      const existing = windows.find(window => groupKey(window.groupName) === groupKey(pool));
      if (existing) return existing.groupName;
    }
    return rule.pools[0]!;
  }
  return declared?.groupName || item.familyName || getAccountModelPool(account, item.id);
}

/**
 * Resolve the model pool name as displayed in the dashboard (including display
 * groups such as "Gemini 4 Neon" or "Claude 4.6" that split a shared quota pool).
 */
export function getAccountModelDisplayPool(
  account: AntigravityAccount,
  id: string,
  allAccounts?: AntigravityAccount[],
): string {
  let display: ReturnType<typeof getProxyConfig>["display"] | undefined;
  try { display = getProxyConfig().display; } catch {}

  const resolvedId = findAccountModel(account, id)?.id || normalizeModelId(id);
  const token = normalizeDisplayToken(resolvedId);
  const matchedQuota = getAccountModelQuotas(account, resolvedId)[0];
  const pool = resolveDisplayQuotaPoolForItem(
    account,
    {
      id: resolvedId,
      groupName: matchedQuota?.groupName,
      limitName: matchedQuota?.limitName,
      familyName: matchedQuota?.familyName || getAccountModelFamily(account, resolvedId),
    },
    display?.poolRules,
  );

  for (const rule of display?.groups || []) {
    if (!matchesDisplayPatterns([token], rule.patterns)) continue;
    if (rule.separateWhen !== "different-accounts") return rule.name;
    const members = allAccounts?.length ? allAccounts : [account];
    const poolAccounts = members.filter(member =>
      getDisplayVisibleQuotaItems(member, display?.visibility).some(item =>
        resolveDisplayQuotaPoolForItem(member, item, display?.poolRules) === pool,
      ),
    );
    const restricted = poolAccounts.filter(member =>
      getDisplayVisibleQuotaItems(member, display?.visibility).some(item =>
        resolveDisplayQuotaPoolForItem(member, item, display?.poolRules) === pool
        && matchesDisplayPatterns([normalizeDisplayToken(item.id)], rule.patterns),
      ),
    );
    if (restricted.length > 0 && restricted.length < poolAccounts.length) {
      return rule.name;
    }
  }
  return pool;
}

/**
 * Returns true if the account has been manually disabled for the target model's pool.
 * Disabling one pool does not affect other pools or the 10-minute window activation.
 */
export function isAccountPoolDisabled(
  account: AntigravityAccount,
  id: string,
  allAccounts?: AntigravityAccount[],
): boolean {
  const disabledPools = account.disabledPools;
  if (!disabledPools?.length) return false;
  const disabledSet = new Set(disabledPools);
  const displayPool = getAccountModelDisplayPool(account, id, allAccounts);
  if (disabledSet.has(displayPool)) return true;

  // Also honor explicit group-level disables even if separateWhen="different-accounts"
  // later merges the group into its shared quota pool (e.g. when all accounts gain access).
  const resolved = normalizeDisplayToken(findAccountModel(account, id)?.id || id);
  let groups: Array<{ name: string; patterns: string[] }> = [];
  try { groups = getProxyConfig().display?.groups || []; } catch {}
  for (const rule of groups) {
    if (disabledSet.has(rule.name) && matchesDisplayPatterns([resolved], rule.patterns)) {
      return true;
    }
  }
  return false;
}

export function updateQuotaFamilies(account: AntigravityAccount): void {
  for (const quota of account.quota || []) {
    if (!quota.modelId) continue;
    const windows = getAccountQuotaWindows(account, quota.modelId);
    const pool = getModelMetadataOverride(quota.modelId)?.quotaPool
      ? windows[0]
      : windows.find(window => !/^(gemini models|claude and gpt models)$/i.test(window.groupName));
    quota.familyName = pool?.groupName || getModelFamilyName(quota.modelId);
  }
}

export function isModernGeminiModel(id: string): boolean {
  const model = normalizeModelId(id);
  if (model === "gemini-pro-orchestrator" || model.startsWith("gemini-pro-orchestrator-") || model === "gemini-flash-worker-agy") return true;
  const generation = model.match(/^gemini-(\d+)/)?.[1];
  return generation !== undefined && Number(generation) >= 3;
}
