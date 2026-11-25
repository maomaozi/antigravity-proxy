import {
  accountSupportsModel,
  findAccountModel,
  getAccountModelQuotas,
  getAccountQuotaWindows,
  getModelFamilyName,
  getAccountModelFamily,
  getAccountModelPool,
  isAccountPoolDisabled,
  isAccountPoolSuspended,
  isAccountTosSuspended,
} from "../models";
import { type AntigravityAccount, type PoolSuspension } from "./types";
import { loadConfig, saveConfig } from "./storage";
import { refreshAccessToken, getProjectId } from "./oauth";
import { generateFingerprint, getAntigravityNativeHeaders } from "../utils/headers";
import { getProxyConfig } from "../config/manager";
import {
  clearTerminatedTosGuardsForAccount,
  deleteSessionBindingsForAccount,
  getSessionBinding,
  getSessionRoutingGuard,
} from "../session/store";
import { EventEmitter } from "events";
import { rendezvousScore } from "../utils/hash";
import { ANTIGRAVITY_STREAM_URL } from "../api/endpoints";
import { transformCompletionToGoogleBody } from "../utils/transform";
import { parseGoogleError } from "../utils/errors";
import { randomUUID } from "node:crypto";

let accounts: AntigravityAccount[] = [];
const cooldownMap = new Map<string, number>();
const googleRefreshPromises = new Map<string, Promise<AntigravityAccount | null>>();

export const eventBus = new EventEmitter();

export function getFamilyName(modelName: string, account?: AntigravityAccount): string {
  return account ? getAccountModelFamily(account, modelName) : getModelFamilyName(modelName);
}

export async function initManager() {
  const config = await loadConfig();
  accounts = config.accounts || [];
  console.log(`[Manager] Loaded ${accounts.length} accounts from storage.`);
}

export function getAccounts() { return accounts; }

export async function setAccountDisabled(
  email: string,
  disabled: boolean,
): Promise<boolean> {
  const account = accounts.find(candidate => candidate.email === email);
  if (!account) return false;
  account.disabled = disabled;
  if (account.suspension?.reason !== "tos_violation") {
    delete account.suspension;
  }
  if (disabled) deleteSessionBindingsForAccount(email, 'sandbox');
  await saveAccounts(accounts);
  return true;
}

export async function setAccountPoolDisabled(
  email: string,
  pool: string,
  disabled: boolean,
): Promise<boolean> {
  const poolName = pool.trim();
  if (!poolName) return false;
  const account = accounts.find(candidate => candidate.email === email);
  if (!account) return false;
  const current = new Set(account.disabledPools || []);
  if (disabled) current.add(poolName);
  else current.delete(poolName);
  const next = [...current].sort();
  if (next.length > 0) account.disabledPools = next;
  else delete account.disabledPools;
  await saveAccounts(accounts);
  return true;
}

export const POOL_SUSPENSION_RETRY_MS = 10 * 60_000;

export async function suspendAccountPool(
  email: string,
  model: string,
  suspension: Pick<PoolSuspension, 'reason' | 'message' | 'appealUrl'>,
  routingModel = model,
): Promise<void> {
  const account = accounts.find(candidate => candidate.email === email);
  if (!account) return;
  const detectedAt = Date.now();
  const isTos = suspension.reason === "tos_violation";
  account.poolSuspensions ||= {};
  const pool = getAccountModelPool(account, routingModel);
  const existing = account.poolSuspensions[pool];
  if (!isTos && (existing?.reason === "tos_violation" || existing?.permanent)) return;
  account.poolSuspensions[pool] = {
    ...suspension,
    model,
    detectedAt,
    retryAt: isTos ? Number.MAX_SAFE_INTEGER : detectedAt + POOL_SUSPENSION_RETRY_MS,
    ...(isTos ? { permanent: true, status: "suspended" } : {}),
  };
  await saveAccounts(accounts, true);
}

export async function clearAccountPoolSuspension(email: string, model: string): Promise<void> {
  const account = accounts.find(candidate => candidate.email === email);
  if (!account?.poolSuspensions) return;
  const pool = getAccountModelPool(account, model);
  const existing = account.poolSuspensions[pool];
  if (!existing || existing.reason === "tos_violation" || existing.permanent) return;
  delete account.poolSuspensions[pool];
  await saveAccounts(accounts, true);
}

function getTosRecoveryTarget(account: AntigravityAccount, model?: string) {
  if (account.suspension?.reason === "tos_violation") return { pool: undefined, suspension: account.suspension };
  const pools = account.poolSuspensions || {};
  const recordedPool = Object.keys(pools).find(key => pools[key]?.reason === "tos_violation" && (!model || pools[key]?.model === model));
  const pool = recordedPool || (model ? getAccountModelPool(account, model) : undefined);
  const suspension = pool ? pools[pool] : undefined;
  if (suspension?.reason === "tos_violation") return { pool, suspension };
  return undefined;
}

export async function beginAccountTosRecovery(email: string, model?: string): Promise<boolean> {
  const account = accounts.find(candidate => candidate.email === email);
  const target = account && getTosRecoveryTarget(account, model);
  if (!target || account?.disabled) return false;
  target.suspension.status = "pending_verification";
  await saveAccounts(accounts, true);
  return true;
}

export async function completeAccountTosRecovery(
  email: string,
  verified: boolean,
  failureDetails?: { message?: string; appealUrl?: string; model?: string },
): Promise<boolean> {
  const account = accounts.find(candidate => candidate.email === email);
  const target = account && getTosRecoveryTarget(account, failureDetails?.model);
  if (!account || target?.suspension.status !== "pending_verification") return false;
  const { pool, suspension } = target;
  if (!verified) {
    suspension.status = "suspended";
    if (failureDetails?.message) suspension.message = failureDetails.message;
    if (failureDetails?.appealUrl) suspension.appealUrl = failureDetails.appealUrl;
    await saveAccounts(accounts, true);
    return false;
  }

  if (pool) delete account.poolSuspensions?.[pool];
  else delete account.suspension;
  clearTerminatedTosGuardsForAccount(email, model => pool
    ? getAccountModelPool(account, model) === pool
    : !isAccountPoolSuspended(account, model));
  await saveAccounts(accounts, true);
  return true;
}

/** Runs an explicit recovery probe for the suspended pool selected by the model. */
export async function verifyAndRecoverTosAccount(
  email: string,
  options: { model?: string; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const account = accounts.find(candidate => candidate.email === email);
  if (!account || account.disabled) return false;
  const target = getTosRecoveryTarget(account, options.model);
  if (!target) return false;
  const probeModel = options.model || target.suspension.model || account.availableModels?.[0]?.id || "gemini-3.8-flash-tiered";
  if (target.suspension.status !== "pending_verification" && !await beginAccountTosRecovery(email, probeModel)) return false;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const ready = await ensureAccountReady(account, false, true);
    if (!ready?.accessToken || !ready.projectId) {
      await completeAccountTosRecovery(email, false, { model: probeModel });
      return false;
    }
    const body = transformCompletionToGoogleBody(
      {
        model: probeModel,
        messages: [{ role: "user", content: "." }],
        stream: false,
        maxOutputTokens: 64,
      },
      ready.projectId,
      "",
      randomUUID(),
      false,
      findAccountModel(ready, probeModel),
    );
    const response = await fetchImpl(ANTIGRAVITY_STREAM_URL, {
      method: "POST",
      headers: getAntigravityNativeHeaders(ready.accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok || /"error"\s*:|"response\.failed"/.test(text)) {
      const parsed = parseGoogleError(text);
      await completeAccountTosRecovery(email, false, {
        message: parsed.message,
        appealUrl: parsed.appealUrl,
        model: probeModel,
      });
      return false;
    }
    return await completeAccountTosRecovery(email, true, { model: probeModel });
  } catch (error: any) {
    await completeAccountTosRecovery(email, false, {
      message: error?.message,
      model: probeModel,
    });
    return false;
  }
}

export async function saveAccounts(newAccounts: AntigravityAccount[], publishImmediately = false) {
  accounts = newAccounts;
  const saved = saveConfig({ accounts });
  if (publishImmediately) eventBus.emit('update', { accounts });
  await saved;
  if (!publishImmediately) eventBus.emit('update', { accounts });
}

function saveAccountsInBackground() {
  void saveAccounts(accounts).catch(error => console.error("[Storage] Failed to save Google accounts:", error));
}

export function getCooldowns(): Record<string, number> {
  return Object.fromEntries(cooldownMap);
}

export function markCooldown(email: string, pool: 'sandbox', modelFamily: string, resetTimeStr?: string) {
  const config = getProxyConfig();
  const account = accounts.find(a => a.email === email);
  const key = `${email}|${pool}|${modelFamily}`;
  let baseDuration = config.rotation.cooldown.defaultDurationMs;

  if (resetTimeStr) {
    if (resetTimeStr === "0s") return;
    baseDuration = parseDuration(resetTimeStr);
  }

  const consecutive = account?.consecutiveFailures || 0;
  const backoffMultiplier = Math.pow(2, Math.min(consecutive, 5));
  const expiry = Date.now() + Math.min(baseDuration * backoffMultiplier, config.rotation.cooldown.maxDurationMs);

  cooldownMap.set(key, expiry);
  if (account) {
    if (!account.cooldowns) account.cooldowns = {};
    account.cooldowns[`${pool}|${modelFamily}`] = expiry;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
    saveAccountsInBackground();
  }
  eventBus.emit('cooldown', { cooldowns: Object.fromEntries(cooldownMap) });
}

export function clearCooldown(email: string, pool: string, modelFamily: string) {
  const key = `${email}|${pool}|${modelFamily}`;
  if (cooldownMap.has(key)) {
    cooldownMap.delete(key);
    const account = accounts.find(a => a.email === email);
    if (account && account.cooldowns) {
      delete account.cooldowns[`${pool}|${modelFamily}`];
      account.consecutiveFailures = 0;
      saveAccountsInBackground();
    }
    eventBus.emit('cooldown', { cooldowns: Object.fromEntries(cooldownMap) });
  }
}

export function resetAllCooldowns() {
  cooldownMap.clear();
  for (const account of accounts) {
    account.cooldowns = {};
    account.consecutiveFailures = 0;
  }
  saveAccountsInBackground();
}

export function flagAccountChallenge(email: string, pool: 'sandbox', modelFamily: string, challenge: any) {
  const account = accounts.find(a => a.email === email);
  if (account) {
    const expiry = Date.now() + 3600000;
    const key = `${email}|${pool}|${modelFamily}`;
    cooldownMap.set(key, expiry);
    if (!account.cooldowns) account.cooldowns = {};
    account.cooldowns[`${pool}|${modelFamily}`] = expiry;
    account.challenge = { ...challenge, detectedAt: Date.now() };
    saveAccountsInBackground();
    eventBus.emit('cooldown', { cooldowns: Object.fromEntries(cooldownMap) });
  }
}

export function isAccountQuotaExhausted(account: AntigravityAccount, model?: string): boolean {
  let config: ReturnType<typeof getProxyConfig>;
  try { config = getProxyConfig(); } catch { return false; }
  const threshold = config.features.softQuotaThresholdPercent;
  const windows = model ? getAccountQuotaWindows(account, model) : (account.quotaWindows || []);
  // Hard exhaustion (including dedicated weekly pools) must not be rescued.
  if (windows.some(window => window.remainingFraction <= 0)) return true;
  const family = model ? getFamilyName(model) : null;
  const relevantQuotas = model ? getAccountModelQuotas(account, model) : (account.quota || []);
  if (relevantQuotas.some(quota => quota.remainingFraction <= 0)) return true;
  if (threshold >= 100) return false;

  if (relevantQuotas.length === 0 && windows.length === 0) return false;

  const usedPercent = [...relevantQuotas, ...windows].reduce((worst, q) => {
    const used = (1 - q.remainingFraction) * 100;
    return Math.max(worst, used);
  }, 0);

  if (usedPercent >= threshold) {
    console.log(`[SoftQuota] Skipping ${account.email} for ${family || 'unknown'}: ${usedPercent.toFixed(1)}% used (threshold: ${threshold}%)`);
    return true;
  }
  return false;
}

function getPidOffset(): number {
  let config: ReturnType<typeof getProxyConfig>;
  try { config = getProxyConfig(); } catch { return 0; }
  if (!config.features.pidOffsetEnabled) return 0;
  return process.pid % Math.max(accounts.length, 1);
}

export type AccountSelectionFailure =
  | "no_accounts"
  | "accounts_disabled"
  | "pool_suspended"
  | "model_not_found"
  | "account_verification_required"
  | "insufficient_quota"
  | "rate_limit_exceeded"
  | "no_available_accounts";

export function quotaRoutingModel(model?: string, reasoningEffort?: string): string | undefined {
  const effort = reasoningEffort?.toLowerCase();
  if (model && effort && /^(low|medium|high|xhigh)$/.test(effort) && !/-(low|medium|high|xhigh)$/i.test(model)) {
    return `${model}-${effort}`;
  }
  return model;
}

/** Explain failed selection using the same capability, quota and cooldown state. */
export function getAccountSelectionFailure(pool: "sandbox", model: string, reasoningEffort?: string): AccountSelectionFailure {
  const routingModel = quotaRoutingModel(model, reasoningEffort)!;
  const configured = accounts.filter(account => account.refreshToken);
  if (configured.length === 0) return "no_accounts";
  const supported = configured.filter(account => accountSupportsModel(account, model, reasoningEffort));
  if (supported.length === 0) return "model_not_found";
  const enabled = supported.filter(account => !account.disabled && !isAccountPoolDisabled(account, routingModel, accounts));
  if (enabled.length === 0) return "accounts_disabled";
  const verified = enabled.filter(account => !account.challenge);
  if (verified.length === 0) return "account_verification_required";
  const usable = verified.filter(account => !isAccountPoolSuspended(account, routingModel));
  if (usable.length === 0) return "pool_suspended";
  if (usable.every(account => isAccountQuotaExhausted(account, routingModel))) return "insufficient_quota";
  const now = Date.now();
  if (usable.every(account => isAccountQuotaExhausted(account, routingModel)
    || (cooldownMap.get(`${account.email}|${pool}|${getFamilyName(routingModel, account)}`) || 0) > now)) {
    return "rate_limit_exceeded";
  }
  return "no_available_accounts";
}

export async function getBestAccount(
  pool?: 'sandbox',
  model?: string,
  sessionKey?: string,
  excludeEmails: string[] = [],
  skipRescue: boolean = false,
  routingKey?: string,
  signal?: AbortSignal,
  reasoningEffort?: string,
): Promise<AntigravityAccount | null> {
  if (accounts.length === 0) return null;
  const now = Date.now();
  const routingModel = quotaRoutingModel(model, reasoningEffort);

  if (pool) {
    let schedulingConfig: ReturnType<typeof getProxyConfig>['scheduling'] | undefined;
    try { schedulingConfig = getProxyConfig().scheduling; } catch {}
    const maxWaitMs = Math.min((schedulingConfig?.maxCacheFirstWaitSeconds || 3) * 1000, 3000);

    // 1. Check persistent routing guard first.
    const guard = sessionKey && model ? getSessionRoutingGuard(sessionKey, model) : null;
    if (guard) {
      if (guard.status === "terminated_tos") {
        return null;
      }
      if (guard.status === "protected_429") {
        if (guard.retryAt && guard.retryAt > now) {
          return null;
        }
        // After retryAt, only the guarded account A may be probed; never fail over to B.
        if (excludeEmails.includes(guard.accountEmail)) {
          return null;
        }
        const guardedAccount = accounts.find(a =>
          a.email === guard.accountEmail
          && a.refreshToken
          && !a.disabled
          && !a.challenge
          && (!routingModel || (!isAccountPoolSuspended(a, routingModel, now) && !isAccountPoolDisabled(a, routingModel, accounts)))
          && (!model || accountSupportsModel(a, model, reasoningEffort))
        );
        if (!guardedAccount) return null;
        const cooldownKey = `${guardedAccount.email}|${pool}|${getFamilyName(model || "Other", guardedAccount)}`;
        const expiry = cooldownMap.get(cooldownKey);
        if (expiry && expiry > now) {
          const waitMs = expiry - now;
          if (waitMs > maxWaitMs) return null;
          if (signal?.aborted) {
            throw new DOMException("Request was aborted by the client", "AbortError");
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, waitMs);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Request was aborted by the client", "AbortError"));
            }, { once: true });
          });
          cooldownMap.delete(cooldownKey);
        } else if (expiry) {
          cooldownMap.delete(cooldownKey);
        }
        return await ensureAccountReady(guardedAccount);
      }
    }

    const usable = accounts.filter(a => a.refreshToken && !a.disabled && !a.challenge && !excludeEmails.includes(a.email)
      && (!routingModel || (!isAccountPoolSuspended(a, routingModel, now) && !isAccountPoolDisabled(a, routingModel, accounts))));

    let candidates = usable.filter(a => {
      if (model && !accountSupportsModel(a, model, reasoningEffort)) return false;
      if (isAccountQuotaExhausted(a, routingModel)) return false;
      const expiry = cooldownMap.get(`${a.email}|${pool}|${getFamilyName(model || "Other", a)}`);
      return !expiry || expiry <= now;
    });

    const binding = sessionKey && model ? getSessionBinding(sessionKey, model) : null;
    const stickyEmail = guard?.accountEmail || binding?.accountEmail;
    if (stickyEmail && !excludeEmails.includes(stickyEmail)) {
      const stickyAccount = usable.find(a =>
        a.email === stickyEmail &&
        (!model || accountSupportsModel(a, model, reasoningEffort)) &&
        !isAccountQuotaExhausted(a, routingModel)
      );
      if (stickyAccount) {
        const cooldownKey = `${stickyEmail}|${pool}|${getFamilyName(model || "Other", stickyAccount)}`;
        const expiry = cooldownMap.get(cooldownKey);
        if (!expiry || expiry <= now) {
          if (expiry) cooldownMap.delete(cooldownKey);
          const ready = await ensureAccountReady(stickyAccount);
          if (ready) return ready;
          // Pinned account refresh failure must not silently jump to B without exhausting A's budget.
          if (guard) return null;
        } else {
          const waitMs = expiry - now;
          if (waitMs <= maxWaitMs) {
            console.log(`[CacheFirst] Waiting ${Math.ceil(waitMs / 1000)}s for session-bound account ${stickyEmail}...`);
            if (signal?.aborted) {
              throw new DOMException("Request was aborted by the client", "AbortError");
            }
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, waitMs);
              signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new DOMException("Request was aborted by the client", "AbortError"));
              }, { once: true });
            });
            cooldownMap.delete(cooldownKey);
            const ready = await ensureAccountReady(stickyAccount);
            if (ready) return ready;
            if (guard) return null;
          } else {
            // Do not switch accounts in an active session merely because the pinned account is cooling down.
            console.log(`[CacheFirst] Session-bound account ${stickyEmail} cooldown (${Math.ceil(waitMs / 1000)}s) exceeds max wait (${maxWaitMs / 1000}s); keeping session pinned.`);
            return null;
          }
        }
      }
    }

    if (candidates.length === 0 && !skipRescue) {
      candidates = usable.filter(a => (!model || accountSupportsModel(a, model, reasoningEffort)))
        .filter(a => {
          if (model && (getAccountModelQuotas(a, routingModel!).some(q => q.remainingFraction <= 0) || getAccountQuotaWindows(a, routingModel!).some(w => w.remainingFraction <= 0))) return false;
          const expiry = cooldownMap.get(`${a.email}|${pool}|${getFamilyName(model || "Other", a)}`);
          return !expiry || expiry <= now;
        })
        .sort((a, b) => {
          const expA = cooldownMap.get(`${a.email}|${pool}|${getFamilyName(model || "Other", a)}`) || 0;
          const expB = cooldownMap.get(`${b.email}|${pool}|${getFamilyName(model || "Other", b)}`) || 0;
          return expA - expB;
        });
    }
    
    if (candidates.length === 0) return null;
    
    if (routingKey) {
      candidates.sort((a, b) => {
        const aScore = rendezvousScore(routingKey, a.email);
        const bScore = rendezvousScore(routingKey, b.email);
        if (aScore === bScore) return a.email.localeCompare(b.email);
        return aScore > bScore ? -1 : 1;
      });
    } else {
      candidates.sort((a, b) => {
          const priorityB = calculatePriority(b, now, model, pool);
          const priorityA = calculatePriority(a, now, model, pool);
          if (Math.abs(priorityA - priorityB) < 0.1) {
              return a.lastUsed - b.lastUsed;
          }
          return priorityB - priorityA;
      });
    }

    const selectedIndex = routingKey ? 0 : getPidOffset() % candidates.length;
    
    return await ensureAccountReady(candidates[selectedIndex]);
  }
  return null;
}

export async function prepareAccountForRequest(email: string, forceRefresh = false): Promise<AntigravityAccount | null> {
  const account = accounts.find(candidate => candidate.email === email);
  return account ? ensureAccountReady(account, forceRefresh) : null;
}

async function ensureAccountReady(
  account: AntigravityAccount,
  forceRefresh = false,
  allowPendingTosVerification = false,
): Promise<AntigravityAccount | null> {
  if (account.disabled) return null;
  if (isAccountTosSuspended(account) && !(allowPendingTosVerification && account.suspension?.status === "pending_verification")) {
    return null;
  }
  const now = Date.now();
  const config = getProxyConfig();
  const needsRefresh = forceRefresh || !account.accessToken || (account.expiresAt && account.expiresAt < now + config.tokens.expiryBufferMs);
  
  if (needsRefresh) {
    const existing = googleRefreshPromises.get(account.email);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const tokens = await refreshAccessToken(account.refreshToken);
        account.accessToken = tokens.access_token;
        account.expiresAt = now + (tokens.expires_in * 1000);
        if (!account.projectId) account.projectId = await getProjectId(account.accessToken) || "rising-fact-p41fc";
        await saveAccounts(accounts);
        return account.disabled ? null : account;
      } catch (e) {
        account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
        account.healthScore = Math.max(0, account.healthScore - 20);
        await saveAccounts(accounts);
        return null;
      } finally {
        googleRefreshPromises.delete(account.email);
      }
    })();

    googleRefreshPromises.set(account.email, promise);
    return promise;
  }
  return account;
}

function calculatePriority(account: AntigravityAccount, now: number, model?: string, pool?: string): number {
  const config = getProxyConfig();
  const secondsSinceUsed = (now - account.lastUsed) / 1000;
  let health = account.healthScore;
  if (model && pool) {
      const family = getFamilyName(model, account);
      let score = account.modelScores?.[`${model}|${pool}`];
      
      if (score === undefined && account.modelScores) {
          let sum = 0;
          let count = 0;
          Object.entries(account.modelScores).forEach(([key, val]) => {
              if (key.endsWith(`|${pool}`) && getFamilyName(key.split('|')[0]) === family) {
                  sum += val;
                  count++;
              }
          });
          if (count > 0) score = sum / count;
      }
      
      if (score !== undefined) health = score;
  }
  return (health * config.scoring.weights.health) + (secondsSinceUsed * config.scoring.weights.lru);
}

export async function updateAccountUsage(email: string, success: boolean, model?: string, pool?: string, status?: number) {
  const account = accounts.find(a => a.email === email);
  if (!account) return;
  if (success && pool && model) clearCooldown(email, pool, getFamilyName(model, account));
  account.lastUsed = Date.now();
  const delta = success ? 2 : (status === 403 ? -50 : -10);
  account.healthScore = Math.max(0, Math.min(100, account.healthScore + delta));
  if (model && pool) {
    if (!account.modelScores) account.modelScores = {};
    const key = `${model}|${pool}`;
    account.modelScores[key] = Math.max(0, Math.min(100, (account.modelScores[key] ?? 100) + delta));
  }
  await saveAccounts(accounts);
}

export function parseDuration(val: string): number {
  const match = val.match(/^(\d+)([smh])$/);
  if (!match) return 60000;
  const amount = parseInt(match[1]);
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000 };
  return amount * multipliers[match[2]];
}

export function flagModelUnsupported(email: string, model: string) {
    const account = accounts.find(a => a.email === email);
    if (account) {
        if (!account.capabilities) account.capabilities = {};
        account.capabilities[model] = false;
        saveAccountsInBackground();
    }
}

export async function resetAccount(email: string) {
    const account = accounts.find(a => a.email === email);
    if (account) {
        account.healthScore = 100;
        account.consecutiveFailures = 0;
        account.cooldowns = {};
        account.modelScores = {};
        account.history = [];
        delete account.challenge;
        const keysToDelete = [];
        for (const [key] of cooldownMap) {
            if (key.startsWith(email + "|")) keysToDelete.push(key);
        }
        for (const key of keysToDelete) cooldownMap.delete(key);
        await saveAccounts(accounts);
    }
}

export async function updateAccountProject(email: string, projectId: string) {
    const account = accounts.find(a => a.email === email);
    if (account) {
        account.projectId = projectId;
        account.managedProjectId = projectId;
        await saveAccounts(accounts);
    }
}

export function getEarliestReset(pool: 'sandbox', model?: string): string | null {
  const usable = accounts.filter(a => a.refreshToken && !a.disabled && !a.challenge && !isAccountTosSuspended(a)
    && (!model || (!isAccountPoolDisabled(a, model, accounts) && !isAccountPoolSuspended(a, model))) && a.quota);
  if (usable.length === 0) return null;
  let resetTimes: number[] = [];
  for (const acc of usable) {
    const quotas = model ? getAccountModelQuotas(acc, model) : (acc.quota || []);
    const windows = model ? getAccountQuotaWindows(acc, model) : (acc.quotaWindows || []);
    [...quotas, ...windows.filter(window => window.remainingFraction < 1)].forEach(q => {
      if (q.resetTime) {
        const t = new Date(q.resetTime).getTime();
        if (!isNaN(t)) resetTimes.push(t);
      }
    });
  }
  if (resetTimes.length === 0) return null;
  const diffMs = Math.max(0, Math.min(...resetTimes) - Date.now());
  return `${Math.floor(diffMs / 3600000)}h ${Math.floor((diffMs % 3600000) / 60000)}m`;
}

export async function addAccount(account: AntigravityAccount) {
  const existing = accounts.find(a => a.email === account.email);
  if (existing) Object.assign(existing, account);
  else accounts.push(account);
  await saveAccounts(accounts);
}

export async function removeAccount(email: string) {
  accounts = accounts.filter(a => a.email !== email);
  deleteSessionBindingsForAccount(email);
  await saveAccounts(accounts);
}

export function emitAccountFlash(email: string, status: 'success' | 'error' = 'success') {
  eventBus.emit('flash', { email, status });
}

export function ensureFingerprint(account: AntigravityAccount): void {
  if (!account.fingerprint || !account.fingerprint.clientMetadata?.sqmId) {
    account.fingerprint = generateFingerprint(account.email);
    saveAccountsInBackground();
  }
}

export function regenerateFingerprint(email: string): void {
  const account = accounts.find(a => a.email === email);
  if (account) {
    account.fingerprint = generateFingerprint(email);
    saveAccountsInBackground();
  }
}
