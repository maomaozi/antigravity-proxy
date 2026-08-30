import { randomUUID } from "node:crypto";
import {
  ensureFingerprint,
  getAccounts,
  prepareAccountForRequest,
  saveAccounts,
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
import { fetchQuota, refreshAllQuotas } from "./quota";

export const WINDOW_ACTIVATION_INTERVAL_MS = 60 * 60_000;

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
  activateGoogle(account: AntigravityAccount): Promise<boolean>;
  activateCodex(email: string): Promise<boolean>;
  refreshCodexUsage(): Promise<void>;
}

export function isGoogleGeminiWindowInactive(account: AntigravityAccount): boolean {
  const geminiQuotas = (account.quota || []).filter(quota => quota.groupName.toLowerCase().includes("gemini"));
  return geminiQuotas.length > 0
    && geminiQuotas.every(quota => Number(quota.remainingFraction) >= 1);
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

function googleActivationModel(account: AntigravityAccount): string {
  const modelIds = (account.quota || [])
    .filter(quota => quota.groupName.toLowerCase().includes("gemini"))
    .map(quota => quota.modelId?.trim())
    .filter((model): model is string => !!model && !model.includes(" "));
  const rank = (model: string): number => {
    const lower = model.toLowerCase();
    if (lower.includes("flash-lite")) return 0;
    if (lower.includes("flash") && !lower.includes("image")) return 1;
    if (lower.includes("flash")) return 2;
    return 3;
  };
  return [...new Set(modelIds)].sort((a, b) => rank(a) - rank(b))[0] || "gemini-2.5-flash";
}

function googleActivationBody(account: AntigravityAccount, model: string): Record<string, unknown> {
  return {
    project: account.projectId,
    model,
    userAgent: "antigravity",
    requestId: `window-activation-${randomUUID()}`,
    requestType: "agent",
    request: {
      contents: [{ role: "user", parts: [{ text: "." }] }],
      generationConfig: { maxOutputTokens: 1 },
      sessionId: randomUUID(),
    },
  };
}

export async function activateGoogleGeminiWindow(
  account: AntigravityAccount,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const send = async (forceRefresh: boolean): Promise<Response | null> => {
    const ready = await prepareAccountForRequest(account.email, forceRefresh);
    if (!ready?.accessToken || !ready.projectId) return null;
    ensureFingerprint(ready);
    const configured = getProxyConfig().endpoints.sandbox;
    const endpoint = (Array.isArray(configured) ? configured : [configured])[0];
    if (!endpoint) return null;
    const model = googleActivationModel(ready);
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
    throw new Error(`Google activation request failed (${response.status}): ${responseBody.slice(0, 300)}`);
  }

  const ready = getAccounts().find(candidate => candidate.email === account.email);
  if (ready) {
    const quota = await fetchQuota(ready, true, fetchImpl);
    if (quota) {
      ready.quota = quota;
      await saveAccounts(getAccounts());
    }
  }
  return true;
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
    activateGoogle: account => activateGoogleGeminiWindow(account, fetchImpl),
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
    if (!isGoogleGeminiWindowInactive(account)) continue;
    try {
      if (await runtime.activateGoogle(account)) {
        summary.googleActivated++;
        console.log(`[WindowActivation] Activated Gemini window for ${account.email}.`);
      } else {
        summary.failures++;
        console.warn(`[WindowActivation] Could not prepare Gemini account ${account.email}.`);
      }
    } catch (error: any) {
      summary.failures++;
      console.warn(`[WindowActivation] Gemini activation failed for ${account.email}: ${error?.message || error}`);
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
        `[WindowActivation] Hourly check complete: Gemini ${summary.googleActivated}/${summary.googleChecked},`
          + ` Codex ${summary.codexActivated}/${summary.codexChecked}, failures ${summary.failures}.`,
      );
    } catch (error: any) {
      console.warn(`[WindowActivation] Hourly check failed: ${error?.message || error}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
