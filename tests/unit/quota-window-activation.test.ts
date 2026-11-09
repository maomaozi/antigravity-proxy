import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_CLIENT_VERSION } from "../../src/models";
import { fetchQuota, fetchQuotaWindows } from "../../src/api/quota";
import {
  isCodexFiveHourWindowInactive,
  isGoogleGeminiWindowInactive,
  runQuotaWindowActivationCheck,
  type WindowActivationRuntime,
} from "../../src/api/window-activation";
import type { AntigravityAccount } from "../../src/auth/types";
import type { CodexUsageSnapshot } from "../../src/codex/account-manager";

function googleAccount(email: string, remainingFraction: number): AntigravityAccount {
  return {
    email,
    refreshToken: "refresh",
    accessToken: "access",
    expiresAt: Date.now() + 3600_000,
    projectId: "project",
    healthScore: 100,
    lastUsed: 0,
    tokenUsage: 0,
    quota: [{
      groupName: "Gemini 3 Flash",
      limit: "unknown",
      usage: "unknown",
      limitName: "gemini",
      remainingFraction,
      quotaLeft: `${Math.round(remainingFraction * 100)}%`,
      resetIn: remainingFraction >= 1 ? "Ready" : "4h 0m",
    }],
  };
}

function codexSnapshot(email: string, usedPercent: number): CodexUsageSnapshot {
  return {
    email,
    accountId: `account-${email}`,
    error: null,
    usage: {
      planType: "plus",
      allowed: true,
      limitReached: false,
      primaryWindow: null,
      secondaryWindow: {
        usedPercent,
        limitWindowSeconds: 5 * 3600,
        resetAt: Date.now() + 5 * 3600_000,
        resetAfterSeconds: usedPercent === 0 ? 5 * 3600 : 4 * 3600,
      },
      credits: null,
    },
  };
}

describe("quota window activation", () => {
  test("disabled accounts are excluded from quota requests and window activation", async () => {
    const account = googleAccount("disabled@example.com", 1);
    account.disabled = true;
    const unexpectedFetch = (async () => { throw new Error("Unexpected quota request"); }) as unknown as typeof fetch;
    expect(await fetchQuota(account, true, unexpectedFetch)).toBeNull();
    expect(await fetchQuotaWindows(account, unexpectedFetch)).toBeNull();
    expect(isGoogleGeminiWindowInactive(account)).toBe(false);
    let activations = 0;
    const summary = await runQuotaWindowActivationCheck({
      refreshGoogleQuotas: async () => {}, listGoogleAccounts: () => [account],
      getCodexUsageSnapshots: async () => [], activateGoogle: async () => { activations++; return true; },
      activateCodex: async () => true, refreshCodexUsage: async () => {},
    });
    expect(activations).toBe(0);
    expect(summary.failures).toBe(0);
  });

  test("rechecks expired pool suspensions even when quota windows are already active", async () => {
    const account = googleAccount('recover@example.com', 0.5);
    const pool = 'Gemini Models';
    account.poolSuspensions = {[pool]: {reason:'tos_violation',model:'gemini-3.8-flash-tiered',detectedAt:1,retryAt:0}};
    const calls:string[] = [];
    const runtime:WindowActivationRuntime = {
      refreshGoogleQuotas:async()=>{}, listGoogleAccounts:()=>[account], getCodexUsageSnapshots:async()=>[],
      activateGoogle:async(a,model)=>{calls.push(model); delete a.poolSuspensions![pool]; return true;},
      activateCodex:async()=>true, refreshCodexUsage:async()=>{},
    };
    await runQuotaWindowActivationCheck(runtime);
    expect(calls).toEqual(['gemini-3.8-flash-tiered']);
    expect(account.poolSuspensions).toEqual({});
    account.poolSuspensions = {[pool]: {reason:'tos_violation',model:'gemini-3.8-flash-tiered',detectedAt:Date.now(),retryAt:Date.now()+600000}};
    await runQuotaWindowActivationCheck(runtime);
    expect(calls).toHaveLength(1);
    account.disabled = true;
    account.poolSuspensions[pool]!.retryAt = 0;
    await runQuotaWindowActivationCheck(runtime);
    expect(calls).toHaveLength(1);
  });

  test("does not turn Google's full unused duration into an active reset countdown", async () => {
    const now = Date.now();
    let requestedUrl = "";
    let requestedHeaders: any;
    const fakeFetch = (async (input: any, init?: any) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      return Response.json({
      availableModels: {
        "models/gemini-unused": {
          displayMetadata: { label: "Gemini Unused" },
          quotaInfo: { remainingFraction: 1, quotaResetTime: "18000s" },
        },
        "models/gemini-used": {
          displayMetadata: { label: "Gemini Used" },
          quotaInfo: { remainingFraction: 0.9, quotaResetTime: "3600s" },
        },
      },
      });
    }) as unknown as typeof fetch;
    const account = googleAccount("quota@example.com", 1);

    const quota = await fetchQuota(account, true, fakeFetch);

    expect(requestedUrl).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    const headers = new Headers(requestedHeaders);
    expect(headers.get("user-agent")).toStartWith(`antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} (aidev_client;`);
    expect(headers.has("client-metadata")).toBe(false);
    expect(headers.has("x-goog-api-client")).toBe(false);
    expect(headers.get("user-agent")).not.toBe("antigravity");

    const unused = quota?.find(item => item.groupName === "Gemini Unused");
    expect(unused).toMatchObject({
      remainingFraction: 1,
      windowActive: false,
      modelId: "gemini-unused",
      resetIn: "Ready",
    });
    expect(unused?.resetTime).toBeUndefined();

    const used = quota?.find(item => item.groupName === "Gemini Used");
    expect(used?.windowActive).toBe(true);
    expect(new Date(used?.resetTime || 0).getTime()).toBeGreaterThanOrEqual(now + 3590_000);
  });

  test("classifies only fully unused Gemini and zero-percent Codex 5h windows as inactive", () => {
    expect(isGoogleGeminiWindowInactive(googleAccount("unused@example.com", 1))).toBe(true);
    expect(isGoogleGeminiWindowInactive(googleAccount("used@example.com", 0.999))).toBe(false);
    expect(isCodexFiveHourWindowInactive(codexSnapshot("unused@example.com", 0).usage)).toBe(true);
    expect(isCodexFiveHourWindowInactive(codexSnapshot("used@example.com", 1).usage)).toBe(false);
    const roundedActive = codexSnapshot("rounded@example.com", 0);
    roundedActive.usage!.secondaryWindow!.resetAfterSeconds = 300;
    expect(isCodexFiveHourWindowInactive(roundedActive.usage)).toBe(false);
  });

  test("scheduled check activates each inactive provider account and refreshes Codex afterward", async () => {
    const activatedGoogle: string[] = [];
    const activatedCodex: string[] = [];
    let codexPostRefreshes = 0;
    const runtime: WindowActivationRuntime = {
      refreshGoogleQuotas: async () => {},
      listGoogleAccounts: () => [
        googleAccount("google-unused@example.com", 1),
        googleAccount("google-used@example.com", 0.8),
      ],
      getCodexUsageSnapshots: async () => [
        codexSnapshot("codex-unused@example.com", 0),
        codexSnapshot("codex-used@example.com", 10),
      ],
      activateGoogle: async account => {
        activatedGoogle.push(account.email);
        account.quota![0].remainingFraction = 0.9999; // the window is now running
        return true;
      },
      activateCodex: async email => {
        activatedCodex.push(email);
        return true;
      },
      refreshCodexUsage: async () => { codexPostRefreshes++; },
    };

    const summary = await runQuotaWindowActivationCheck(runtime);

    expect(activatedGoogle).toEqual(["google-unused@example.com"]);
    expect(activatedCodex).toEqual(["codex-unused@example.com"]);
    expect(codexPostRefreshes).toBe(1);
    expect(summary).toEqual({
      googleChecked: 2,
      googleActivated: 1,
      codexChecked: 2,
      codexActivated: 1,
      failures: 0,
    });
  });

  test("activation prefers 3.8 Flash and only counts a window once the refreshed quota shows it running", async () => {
    const account = googleAccount("fallback@example.com", 1);
    account.quota = [
      { ...account.quota![0], groupName: "Gemini 3 Flash", limitName: "gemini", modelId: "gemini-3-flash" },
      { ...account.quota![0], groupName: "Gemini 3.8 Flash", limitName: "gemini", modelId: "gemini-3.8-flash-low" },
    ];
    const tried: string[] = [];
    const summary = await runQuotaWindowActivationCheck({
      refreshGoogleQuotas: async () => {}, listGoogleAccounts: () => [account],
      getCodexUsageSnapshots: async () => [], activateCodex: async () => true, refreshCodexUsage: async () => {},
      activateGoogle: async (current, model) => {
        tried.push(model);
        if (model.includes("3.8")) current.quota!.forEach(q => { q.remainingFraction = 0.9999; });
        return true; // gemini-3-flash answers 200 but never counts against the pool
      },
    });
    expect(tried[0]).toBe("gemini-3.8-flash-low");
    expect(summary.googleActivated).toBe(1);
    expect(summary.failures).toBe(0);
  });
});
