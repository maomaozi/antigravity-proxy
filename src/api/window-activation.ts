import { accountSupportsModel, findAccountModel, getAccountQuotaWindows, getModelFamilyName, updateQuotaFamilies } from "../models";
import { transformCompletionToGoogleBody } from "../utils/transform";
import { randomUUID } from "node:crypto";
import {
  ensureFingerprint,
  getAccounts,
  prepareAccountForRequest,
  saveAccounts,
  setAccountDisabled,
} from "../auth/manager";
import type { AntigravityAccount } from "../auth/types";
import { callCodexResponsesAPI } from "../codex/api";
import type {
  CodexAccountManager,
  CodexUsage,
  CodexUsageSnapshot,
} from "../codex/account-manager";
import { getProxyConfig } from "../config/manager";
import { getImpersonationHeaders } from "../utils/headers";
import { parseGoogleError } from "../utils/errors";
import { fetchQuota, fetchQuotaWindows, refreshAllQuotas } from "./quota";

export const WINDOW_ACTIVATION_INTERVAL_MS = 10 * 60_000;

export interface WindowActivationSummary {
  googleChecked: number;
  googleActivated: number;
  codexChecked: number;
  codexActivated: number;
  failures: number;
}

export interface WindowActivationRuntime {
  refreshGoogleQuotas(): Promise<void>;
  listGoogleAccounts(): AntigravityAccount[];
  getCodexUsageSnapshots(): Promise<CodexUsageSnapshot[]>;
  activateGoogle(account: AntigravityAccount, model: string): Promise<boolean>;
  activateCodex(email: string): Promise<boolean>;
  refreshCodexUsage(): Promise<void>;
}

export interface GoogleActivationTarget {
  key: string;
  model: string;
  /** Ordered fallbacks from the same pool, used when `model` has no capacity. */
  models: string[];
}

/** Flash models are cheapest and rarely capacity-limited; Pro/Opus-class are last. */
function activationModelRank(model: string): number {
  // Some models (e.g. gemini-3-flash) answer successfully but never start the pool's window.
  if (/3\.8-flash/i.test(model)) return 0;
  if (/flash(?!.*(image|lite))/i.test(model)) return 1;
  if (/lite/i.test(model)) return 2;
  if (/sonnet|gpt-oss|haiku/i.test(model)) return 3;
  return 4;
}

/** One request per independent pool, never one hard-coded model per account. */
export function getGoogleActivationTargets(account: AntigravityAccount): GoogleActivationTarget[] {
  if (account.disabled || account.challenge || !account.refreshToken) return [];
  const targets = new Map<string, GoogleActivationTarget>();
  const active = new Set<string>();
  for (const quota of account.quota || []) {
    const model = (quota.modelIds || (quota.modelId ? [quota.modelId] : []))
      .find(id => !/image/i.test(id) && accountSupportsModel(account, id))
      || (!account.availableModels && !quota.modelId && /gemini/i.test(quota.groupName) ? "gemini-3.8-flash-tiered" : undefined);
    if (!model) continue;
    const windows = getAccountQuotaWindows(account, model);
    const key = windows[0]?.groupName || quota.limitName;
    if (quota.remainingFraction < 1) active.add(key);
    if (quota.remainingFraction !== 1 || windows.some(window => window.remainingFraction <= 0)) continue;
    const shortWindows = windows.filter(window => window.window === '5h');
    // Weekly-only dedicated pools (e.g. Argon) can be activated when unused too.
    const activationWindows = shortWindows.length ? shortWindows : windows;
    if (activationWindows.some(window => window.remainingFraction < 1)) continue;
    const target = targets.get(key) || { key, model, models: [] };
    if (!target.models.includes(model)) target.models.push(model);
    targets.set(key, target);
  }
  for (const target of targets.values()) {
    target.models.sort((a, b) => activationModelRank(a) - activationModelRank(b));
    target.model = target.models[0];
  }
  return [...targets.values()].filter(target => !active.has(target.key));
}

/** Compatibility helper retained for callers interested only in Gemini. */
export function isGoogleGeminiWindowInactive(account: AntigravityAccount): boolean {
  return getGoogleActivationTargets(account).some(target => getModelFamilyName(target.model).startsWith("Gemini"));
}

export function isCodexFiveHourWindowInactive(usage: CodexUsage | null): boolean {
  if (!usage) return false;
  const fiveHourWindows = [usage.primaryWindow, usage.secondaryWindow].filter(window => {
    const seconds = Number(window?.limitWindowSeconds);
    return Number.isFinite(seconds) && seconds >= 4 * 3600 && seconds <= 6 * 3600;
  });
  return fiveHourWindows.length > 0 && fiveHourWindows.some(window => {
    if (window?.usedPercent === null || window?.usedPercent === undefined) return false;
    if (Number(window.usedPercent) !== 0) return false;
    const duration = Number(window.limitWindowSeconds);
    const remaining = Number(window.resetAfterSeconds);
    if (Number.isFinite(remaining)) return remaining >= duration - 5;
    const resetAt = Number(window.resetAt);
    return Number.isFinite(resetAt) && resetAt - Date.now() >= (duration - 5) * 1000;
  });
}

function googleActivationBody(account: AntigravityAccount, model: string): Record<string, unknown> {
  const body = transformCompletionToGoogleBody({
    model, messages: [{ role: "user", content: "." }], stream: false,
    maxOutputTokens: 2048, thinkingBudget: 1024,
  }, account.projectId!, "", randomUUID(), false, findAccountModel(account, model));
  return { ...body, requestId: `window-activation-${randomUUID()}` };
}

export async function activateGoogleModelWindow(
  account: AntigravityAccount,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!accountSupportsModel(account, model) || account.disabled || account.challenge) return false;
  const send = async (forceRefresh: boolean): Promise<Response | null> => {
    const ready = await prepareAccountForRequest(account.email, forceRefresh);
    if (!ready?.accessToken || !ready.projectId) return null;
    ensureFingerprint(ready);
    const configured = getProxyConfig().endpoints.sandbox;
    const endpoint = (Array.isArray(configured) ? configured : [configured])[0];
    if (!endpoint) return null;
    return fetchImpl(endpoint, {
      method: "POST",
      headers: getImpersonationHeaders(ready.accessToken, ready.fingerprint, model),
      body: JSON.stringify(googleActivationBody(ready, model)),
      signal: AbortSignal.timeout(60_000),
    });
  };

  let response = await send(false);
  if (response?.status === 401) {
    await response.text().catch(() => "");
    response = await send(true);
  }
  if (!response) return false;
  const responseBody = await response.text().catch(() => "");
  if (!response.ok) {
    const parsed = parseGoogleError(responseBody);
    if (response.status === 403 && parsed.isAccountSuspended) {
      await setAccountDisabled(account.email, true, {
        reason: parsed.reason, message: parsed.message, appealUrl: parsed.appealUrl,
      });
    }
    throw new Error(`Google activation request failed (${response.status}): ${responseBody.slice(0, 300)}`);
  }

  if (/"error"\s*:|"response.failed"/.test(responseBody)) {
    throw new Error(`Google activation stream failed: ${responseBody.slice(0, 300)}`);
  }
  const ready = getAccounts().find(candidate => candidate.email === account.email);
  if (ready) {
    const quota = await fetchQuota(ready, true, fetchImpl);
    if (quota) {
      ready.quota = quota;
      const windows = await fetchQuotaWindows(ready, fetchImpl);
      if (windows !== null) ready.quotaWindows = windows;
      updateQuotaFamilies(ready);
      await saveAccounts(getAccounts());
    }
  }
  return true;
}

export async function activateGoogleGeminiWindow(account: AntigravityAccount, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const target = getGoogleActivationTargets(account).find(target => getModelFamilyName(target.model).startsWith("Gemini"));
  return activateGoogleModelWindow(account, target?.model || "gemini-3.8-flash-tiered", fetchImpl);
}

function codexActivationModel(): string | null {
  const models = getProxyConfig().codex.models.filter(model => typeof model === "string" && model.trim());
  return models.find(model => model.toLowerCase().includes("luna"))
    || models.find(model => model.toLowerCase().includes("terra"))
    || models[0]
    || null;
}

export async function activateCodexWindow(
  manager: CodexAccountManager,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const model = codexActivationModel();
  if (!model) return false;
  const send = async (forceRefresh: boolean): Promise<Response | null> => {
    const account = await manager.prepareAccountForRequest(email, forceRefresh);
    if (!account) return null;
    return callCodexResponsesAPI({
      accessToken: account.accessToken,
      accountId: account.accountId,
      sessionId: randomUUID(),
      body: {
        model,
        input: ".",
        instructions: "Reply with one character.",
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
        store: false,
      },
      timeoutMs: Math.min(getProxyConfig().codex.responsesTimeoutMs, 60_000),
      fetchImpl,
      baseUrl: getProxyConfig().codex.baseUrl,
    });
  };

  let response = await send(false);
  if (response?.status === 401) {
    await response.text().catch(() => "");
    response = await send(true);
  }
  if (!response) return false;
  const responseBody = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Codex activation request failed (${response.status}): ${responseBody.slice(0, 300)}`);
  }
  if (responseBody.includes("event: response.failed") && !responseBody.includes("event: response.completed")) {
    throw new Error("Codex activation stream ended with response.failed");
  }
  return true;
}

export function createWindowActivationRuntime(
  codexManager: CodexAccountManager,
  fetchImpl: typeof fetch = fetch,
): WindowActivationRuntime {
  return {
    refreshGoogleQuotas: refreshAllQuotas,
    listGoogleAccounts: getAccounts,
    getCodexUsageSnapshots: () => getProxyConfig().codex.enabled
      ? codexManager.getUsageSnapshots()
      : Promise.resolve([]),
    activateGoogle: (account, model) => activateGoogleModelWindow(account, model, fetchImpl),
    activateCodex: email => activateCodexWindow(codexManager, email, fetchImpl),
    refreshCodexUsage: async () => {
      if (getProxyConfig().codex.enabled) await codexManager.getUsageSnapshots();
    },
  };
}

export async function runQuotaWindowActivationCheck(
  runtime: WindowActivationRuntime,
): Promise<WindowActivationSummary> {
  const summary: WindowActivationSummary = {
    googleChecked: 0,
    googleActivated: 0,
    codexChecked: 0,
    codexActivated: 0,
    failures: 0,
  };

  try {
    await runtime.refreshGoogleQuotas();
  } catch (error: any) {
    summary.failures++;
    console.warn(`[WindowActivation] Google quota refresh failed: ${error?.message || error}`);
  }

  for (const account of runtime.listGoogleAccounts()) {
    summary.googleChecked++;
    for (const target of getGoogleActivationTargets(account)) {
      if (account.disabled || account.challenge) break;
      // The previous activation refreshes this account, and may activate shared quotas.
      if (!getGoogleActivationTargets(account).some(current => current.key === target.key)) continue;
      let activated = false;
      for (const model of target.models) {
        try {
          if (await runtime.activateGoogle(account, model)) {
            // A 2xx is not proof: only count it once the refreshed quota shows the window running.
            if (getGoogleActivationTargets(account).some(current => current.key === target.key)) {
              console.warn(`[WindowActivation] ${model} answered but ${target.key} is still inactive for ${account.email}.`);
              continue;
            }
            activated = true;
            summary.googleActivated++;
            console.log(`[WindowActivation] Activated ${target.key} (${model}) for ${account.email}.`);
            break;
          }
          console.warn(`[WindowActivation] Could not prepare ${model} for ${account.email}.`);
        } catch (error: any) {
          console.warn(`[WindowActivation] ${model} activation failed for ${account.email}: ${String(error?.message || error).slice(0, 200)}`);
          if (account.disabled || account.challenge) break;
        }
      }
      if (!activated) summary.failures++;
    }
  }

  let codexSnapshots: CodexUsageSnapshot[] = [];
  try {
    codexSnapshots = await runtime.getCodexUsageSnapshots();
  } catch (error: any) {
    summary.failures++;
    console.warn(`[WindowActivation] Codex usage refresh failed: ${error?.message || error}`);
  }

  for (const snapshot of codexSnapshots) {
    summary.codexChecked++;
    if (snapshot.error || !isCodexFiveHourWindowInactive(snapshot.usage)) continue;
    try {
      if (await runtime.activateCodex(snapshot.email)) {
        summary.codexActivated++;
        console.log(`[WindowActivation] Activated Codex window for ${snapshot.email}.`);
      } else {
        summary.failures++;
        console.warn(`[WindowActivation] Could not prepare Codex account ${snapshot.email}.`);
      }
    } catch (error: any) {
      summary.failures++;
      console.warn(`[WindowActivation] Codex activation failed for ${snapshot.email}: ${error?.message || error}`);
    }
  }

  if (summary.codexActivated > 0) {
    try {
      await runtime.refreshCodexUsage();
    } catch (error: any) {
      summary.failures++;
      console.warn(`[WindowActivation] Codex post-activation refresh failed: ${error?.message || error}`);
    }
  }
  return summary;
}

export function startQuotaWindowActivationScheduler(
  runtime: WindowActivationRuntime,
  intervalMs = WINDOW_ACTIVATION_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runQuotaWindowActivationCheck(runtime);
      console.log(
        `[WindowActivation] 10-minute check complete: Google pools ${summary.googleActivated}/${summary.googleChecked},`
          + ` Codex ${summary.codexActivated}/${summary.codexChecked}, failures ${summary.failures}.`,
      );
    } catch (error: any) {
      console.warn(`[WindowActivation] 10-minute check failed: ${error?.message || error}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
