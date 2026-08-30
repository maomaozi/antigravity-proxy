import { describe, expect, test } from "bun:test";
import { fetchQuota } from "../../src/api/quota";
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
  test("does not turn Google's full unused duration into an active reset countdown", async () => {
    const now = Date.now();
    const fakeFetch = (async () => Response.json({
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
    })) as unknown as typeof fetch;
    const account = googleAccount("quota@example.com", 1);

    const quota = await fetchQuota(account, true, fakeFetch);

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

  test("hourly check activates each inactive provider account and refreshes Codex afterward", async () => {
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
});
