import { getAntigravityNativeHeaders } from "../utils/headers";
import { type AntigravityAccount } from "../auth/types";
import { getAccounts, saveAccounts } from "../auth/manager";
import { parseGoogleError } from "../utils/errors";
import { refreshAccessToken } from "../auth/oauth";
import { ANTIGRAVITY_BASE_URL } from "./endpoints";
import {
  getUnavailableModelError,
  normalizeModelId,
  findAccountModel,
  getModelFamilyName,
  getAccountModelQuotas,
  getAccountQuotaWindows,
  isAccountTosSuspended,
  updateQuotaFamilies,
  type DiscoveredModel,
} from "../models";

export const QUOTA_FRESHNESS_MAX_AGE_MS = 60_000;
export const OBVIOUSLY_SUFFICIENT_QUOTA_THRESHOLD = 0.05;

export interface AccountModelQuotaEvaluation {
  targetModel: string;
  quotaFresh: boolean;
  windowsFresh: boolean;
  hasMatchedQuotas: boolean;
  hasMatchedWindows: boolean;
  obviouslySufficient: boolean;
  confirmedExhausted: boolean;
  needsRefresh: boolean;
  earliestResetSeconds?: number;
}

export function evaluateAccountModelQuotaState(
  account: AntigravityAccount,
  model: string,
  reasoningEffort?: string,
  now = Date.now(),
): AccountModelQuotaEvaluation {
  const discovered = findAccountModel(account, model, reasoningEffort);
  const routingModel = discovered?.id
    || (reasoningEffort && /^(low|medium|high|xhigh)$/i.test(reasoningEffort) && !/-(low|medium|high|xhigh)$/i.test(model)
      ? `${model}-${reasoningEffort.toLowerCase()}`
      : model);

  const quotas = getAccountModelQuotas(account, routingModel);
  const windows = getAccountQuotaWindows(account, routingModel);

  const quotaFresh =
    typeof account.quotaUpdatedAt === "number"
    && Number.isFinite(account.quotaUpdatedAt)
    && now - account.quotaUpdatedAt >= -5_000
    && now - account.quotaUpdatedAt <= QUOTA_FRESHNESS_MAX_AGE_MS;

  const windowsFresh =
    typeof account.quotaWindowsUpdatedAt === "number"
    && Number.isFinite(account.quotaWindowsUpdatedAt)
    && now - account.quotaWindowsUpdatedAt >= -5_000
    && now - account.quotaWindowsUpdatedAt <= QUOTA_FRESHNESS_MAX_AGE_MS;

  const hasMatchedQuotas = quotas.length > 0;
  const hasMatchedWindows = windows.length > 0;

  const quotaExhausted = quotaFresh && hasMatchedQuotas && quotas.some(q => q.remainingFraction <= 0);
  const windowExhausted = windowsFresh && hasMatchedWindows && windows.some(w => w.remainingFraction <= 0);
  const confirmedExhausted = quotaExhausted || windowExhausted;

  const obviouslySufficient =
    quotaFresh
    && windowsFresh
    && hasMatchedQuotas
    && hasMatchedWindows
    && !confirmedExhausted
    && quotas.every(q => q.remainingFraction > OBVIOUSLY_SUFFICIENT_QUOTA_THRESHOLD)
    && windows.every(w => w.remainingFraction > OBVIOUSLY_SUFFICIENT_QUOTA_THRESHOLD);

  const needsRefresh = !quotaFresh || !windowsFresh || !hasMatchedQuotas || !hasMatchedWindows;

  let earliestResetSeconds: number | undefined;
  const exhaustedItems = [
    ...(quotaFresh ? quotas.filter(q => q.remainingFraction <= 0) : []),
    ...(windowsFresh ? windows.filter(w => w.remainingFraction <= 0) : []),
  ];
  for (const item of exhaustedItems) {
    if (item.resetTime) {
      const resetMs = Date.parse(item.resetTime);
      if (Number.isFinite(resetMs) && resetMs > now) {
        const secs = Math.ceil((resetMs - now) / 1000);
        if (earliestResetSeconds === undefined || secs < earliestResetSeconds) {
          earliestResetSeconds = secs;
        }
      }
    }
  }

  return {
    targetModel: routingModel,
    quotaFresh,
    windowsFresh,
    hasMatchedQuotas,
    hasMatchedWindows,
    obviouslySufficient,
    confirmedExhausted,
    needsRefresh,
    earliestResetSeconds,
  };
}

export async function fetchQuotaWindows(
  account: AntigravityAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<AntigravityAccount['quotaWindows'] | null> {
  if (account.disabled || isAccountTosSuspended(account) || !account.accessToken) return null;
  try {
    const response = await fetchImpl(`${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: getAntigravityNativeHeaders(account.accessToken),
      body: JSON.stringify({ project: 'aicode-consumers' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await logQuotaAccessFailure(account, response);
      return null;
    }
    const data = await response.json() as any;
    if (!Array.isArray(data.groups)) return null;
    const windows: NonNullable<AntigravityAccount['quotaWindows']> = [];
    for (const group of data.groups) {
      if (typeof group?.displayName !== 'string' || !Array.isArray(group.buckets)) continue;
      for (const bucket of group.buckets) {
        if (bucket?.window !== '5h' && bucket?.window !== 'weekly') continue;
        // Protobuf omits default numeric values; an absent fraction means exhausted.
        const remaining = bucket.remainingFraction ?? 0;
        if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
        windows.push({
          groupName: group.displayName,
          window: bucket.window,
          remainingFraction: Math.max(0, Math.min(1, remaining)),
          resetTime: typeof bucket.resetTime === 'string' && Number.isFinite(Date.parse(bucket.resetTime))
            ? bucket.resetTime : undefined,
        });
      }
    }
    account.quotaWindowsUpdatedAt = Date.now();
    return windows;
  } catch (error) {
    console.error(`Error fetching quota windows for ${account.email}`, error);
    return null;
  }
}

export async function fetchQuota(
  account: AntigravityAccount,
  retry = true,
  fetchImpl: typeof fetch = fetch,
): Promise<AntigravityAccount['quota'] | null> {
  if (account.disabled || isAccountTosSuspended(account) || !account.projectId || !account.accessToken) return null;

  try {
    const res = await fetchImpl(`${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: getAntigravityNativeHeaders(account.accessToken),
      body: JSON.stringify({
        project: account.projectId
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401 && retry) {
      console.log(`Quota fetch 401 for ${account.email}, refreshing token...`);
      try {
        const tokens = await refreshAccessToken(account.refreshToken);
        account.accessToken = tokens.access_token;
        account.expiresAt = Date.now() + (tokens.expires_in * 1000);
        await saveAccounts(getAccounts());
        return fetchQuota(account, false, fetchImpl); // Retry once
      } catch (e) {
        console.error(`Failed to refresh token for ${account.email} during quota fetch`, e);
        return null;
      }
    }

    if (!res.ok) {
        await logQuotaAccessFailure(account, res);
        console.error(`Quota fetch failed for ${account.email}: ${res.status}`);
        return null;
    }

    const data = await res.json();
    const parsed = parseQuotaResponse(data);
    if (parsed === null) return null;
    const models = modelEntries(data).filter(([id, model]) => isPublicModel(id, model));
    account.availableModels = models.map(([id, model]) => ({
      id: normalizeModelId(id),
      name: model.displayMetadata?.label || model.displayName || id,
      supportsThinking: model.supportsThinking === true,
      maxOutputTokens: typeof model.maxOutputTokens === "number" ? model.maxOutputTokens : undefined,
      modelEnum: typeof model.model === "string" ? model.model : undefined,
      thinkingLevel: typeof model.thinkingLevel === "number" ? model.thinkingLevel : undefined,
    } satisfies DiscoveredModel));
    // A successful discovery supersedes old unsupported responses for advertised models.
    for (const key of Object.keys(account.capabilities || {})) {
      if (findAccountModel(account, key)) delete account.capabilities![key];
    }
    account.quotaUpdatedAt = Date.now();
    updateQuotaFamilies({ ...account, quota: parsed });
    return parsed;
  } catch (e) {
    console.error(`Error fetching quota for ${account.email}`, e);
  }
  return null;
}

function getNextMidnightPT(): string {
    const now = new Date();
    const ptDateStr = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const ptDate = new Date(ptDateStr);

    const midnightPT = new Date(ptDate);
    midnightPT.setHours(24, 0, 0, 0);

    const diffMs = midnightPT.getTime() - ptDate.getTime();
    return new Date(now.getTime() + diffMs).toISOString();
}

async function logQuotaAccessFailure(account: AntigravityAccount, response: Response): Promise<void> {
  if (response.status !== 403) return;
  const parsed = parseGoogleError(await response.text());
  if (parsed.isServiceSuspended) {
    // These endpoints have no target model: a failure is not evidence that any
    // particular generation pool is suspended. Keep prior quota data and retry.
    console.warn(`[Quota] Access denied for ${account.email}; no model pool can be inferred: ${parsed.reason}`);
  }
}

function modelEntries(data: any): [string, any][] {
    const models = data?.availableModels ?? data?.models;
    if (!models || typeof models !== 'object') return [];
    return Array.isArray(models)
      ? models.map((m: any) => [m.name || m.id || m.model?.name || "", m])
      : Object.entries(models);
}

function isPublicModel(id: string, model: any): boolean {
    return typeof id === 'string' && !!model && !model.disabled && !model.isInternal && !getUnavailableModelError(id)
      && /^(gemini|claude|gpt)-/.test(normalizeModelId(id));
}

export function parseQuotaResponse(data: any): AntigravityAccount['quota'] | null {
    if (!data || typeof (data.availableModels ?? data.models) !== 'object' || (data.availableModels ?? data.models) === null) return null;
    const entries = modelEntries(data);
    const groups = new Map<string, any>();

    for (const [key, m] of entries) {
        if (!isPublicModel(key, m) || !m.quotaInfo) continue;
        const modelId = normalizeModelId(key);
        const label = m.displayMetadata?.label || m.displayName || modelId;
        const remaining = m.quotaInfo.remainingFraction ?? 0;
        if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
        const remainingFraction = Math.max(0, Math.min(1, remaining));
        const windowActive = remainingFraction < 1;

        const limitName = m.quotaInfo.limitName || label;

        let resetTime = windowActive ? (m.quotaInfo.quotaResetTime ||
                       m.quotaResetTime ||
                       m.quotaInfo.resetTime ||
                       m.resetTime ||
                       m.quotaInfo.nextResetTime ||
                       m.nextResetTime ||
                       m.quotaInfo.quota_reset_time ||
                       m.quota_reset_time) : undefined;

        if (typeof resetTime === 'number') {
            if (resetTime < 10000000000) resetTime *= 1000;
            resetTime = new Date(resetTime).toISOString();
        }

        if (typeof resetTime === 'string' && resetTime.endsWith('s') && /^\d+/.test(resetTime)) {
            const seconds = parseInt(resetTime, 10);
            if (!isNaN(seconds)) {
                resetTime = new Date(Date.now() + seconds * 1000).toISOString();
            }
        }

        if (windowActive && (!resetTime || Number.isNaN(new Date(resetTime).getTime()))) {
            resetTime = getNextMidnightPT();
        }

        const diffMs = resetTime ? Math.max(0, new Date(resetTime).getTime() - Date.now()) : 0;
        const hours = Math.floor(diffMs / (1000 * 60 * 60));
        const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const resetIn = windowActive ? `${hours}h ${minutes}m` : "Ready";
        const pct = Math.round(remainingFraction * 100);
        const quotaLeft = `${pct}%`;

        if (groups.has(limitName)) {
            const group = groups.get(limitName);
            if (!group.modelIds.includes(modelId)) group.modelIds.push(modelId);
            if (remainingFraction < group.remainingFraction) {
                group.resetTime = resetTime;
                group.resetIn = resetIn;
            }
            group.remainingFraction = Math.min(group.remainingFraction, remainingFraction);
            group.quotaLeft = `${Math.round(group.remainingFraction * 100)}%`;
            group.windowActive = group.remainingFraction < 1;
            // Append label if not already present
            if (!group.labels.includes(label)) {
                group.labels.push(label);
                group.labels.sort();
                group.groupName = group.labels.join(" / ");
            }
        } else {
            groups.set(limitName, {
                groupName: label,
                familyName: getModelFamilyName(modelId),
                modelIds: [modelId],
                labels: [label],
                limit: m.quotaInfo.quotaLimit || "Unknown",
                usage: m.quotaInfo.quotaUsage || "Unknown",
                limitName: limitName,
                remainingFraction: remainingFraction,
                windowActive,
                modelId: modelId && !modelId.includes(" ") ? modelId : undefined,
                resetTime: resetTime,
                quotaLeft,
                resetIn
            });
        }
    }

    const results = Array.from(groups.values()).map(g => {
        const { labels, ...rest } = g;
        return rest;
    });

    // Sort by name for consistency
    results.sort((a, b) => a.groupName.localeCompare(b.groupName));

    return results;
}

const accountOnDemandRefreshInFlight = new Map<string, Promise<boolean>>();

/**
 * Single-flight on-demand quota + quotaWindows refresh for a specific account when a 429
 * encounters missing, stale (>60s), or conflicting quota data. Concurrent callers and outer
 * retries join the same in-flight promise instead of triggering duplicate refreshes.
 */
export function refreshAccountQuotaSingleFlight(
  account: AntigravityAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (account.disabled || isAccountTosSuspended(account) || !account.projectId || !account.accessToken) {
    return Promise.resolve(false);
  }
  const existing = accountOnDemandRefreshInFlight.get(account.email);
  if (existing) return existing;

  const task = (async () => {
    const [quota, windows] = await Promise.all([
      fetchQuota(account, true, fetchImpl),
      fetchQuotaWindows(account, fetchImpl),
    ]);
    let changed = false;
    if (quota !== null) {
      account.quota = quota;
      changed = true;
    }
    if (windows !== null) {
      account.quotaWindows = windows;
      changed = true;
    }
    if (changed) {
      updateQuotaFamilies(account);
      await saveAccounts(getAccounts());
    }
    return quota !== null && windows !== null;
  })().finally(() => {
    accountOnDemandRefreshInFlight.delete(account.email);
  });

  accountOnDemandRefreshInFlight.set(account.email, task);
  return task;
}

let quotaRefreshInFlight: Promise<void> | null = null;

async function performQuotaRefresh(): Promise<void> {
    const accounts = getAccounts();
    let changed = false;
    await Promise.all(accounts.map(async acc => {
        if (!acc.disabled && !isAccountTosSuspended(acc) && acc.projectId) {
            const quota = await fetchQuota(acc);
            const windows = await fetchQuotaWindows(acc);
            if (windows !== null) {
                acc.quotaWindows = windows;
                changed = true;
            }
            if (quota) {
                acc.quota = quota;
                changed = true;
            }
            updateQuotaFamilies(acc);
        }
    }));
    if (changed) await saveAccounts(getAccounts());
}

export function refreshAllQuotas(): Promise<void> {
    if (quotaRefreshInFlight) return quotaRefreshInFlight;
    quotaRefreshInFlight = performQuotaRefresh().finally(() => {
        quotaRefreshInFlight = null;
    });
    return quotaRefreshInFlight;
}
