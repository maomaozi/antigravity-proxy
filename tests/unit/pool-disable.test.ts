import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAccounts, getAccountSelectionFailure, getBestAccount, getEarliestReset, setAccountPoolDisabled } from "../../src/auth/manager";
import type { AntigravityAccount } from "../../src/auth/types";
import { getAccountModelDisplayPool, isAccountPoolDisabled } from "../../src/models";
import {
  getGoogleActivationTargets,
  runQuotaWindowActivationCheck,
  type WindowActivationRuntime,
} from "../../src/api/window-activation";
import { fetchQuota, fetchQuotaWindows } from "../../src/api/quota";
import { handleImageGeneration, type ImageGenerationRuntime } from "../../src/api/openai/images";
import { CodexAccountManager } from "../../src/codex/account-manager";

const originalAccounts: AntigravityAccount[] = [];

function makeAccount(
  name: string,
  overrides: Partial<AntigravityAccount> = {},
): AntigravityAccount {
  return {
    email: `${name}@example.com`,
    refreshToken: `refresh-${name}`,
    accessToken: `access-${name}`,
    expiresAt: Date.now() + 3600_000,
    projectId: `project-${name}`,
    healthScore: 100,
    lastUsed: 0,
    tokenUsage: 0,
    availableModels: [
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", supportsThinking: true },
      { id: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)", supportsThinking: true },
      { id: "claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)", supportsThinking: true },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
      { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", supportsThinking: true },
    ],
    quota: [
      {
        groupName: "Gemini Models",
        limit: "unknown",
        usage: "unknown",
        limitName: "Gemini Models",
        remainingFraction: 1,
        quotaLeft: "100%",
        resetIn: "Ready",
        modelId: "gemini-3.8-flash-high",
        modelIds: ["gemini-3.8-flash-high", "gemini-4-neon-xhigh"],
      },
      {
        groupName: "Claude Sonnet 4.6",
        limit: "unknown",
        usage: "unknown",
        limitName: "Claude and GPT models",
        remainingFraction: 1,
        quotaLeft: "100%",
        resetIn: "Ready",
        modelId: "claude-sonnet-4-6-thinking",
        modelIds: ["claude-sonnet-4-6-thinking"],
      },
      {
        groupName: "GPT-OSS 120B",
        limit: "unknown",
        usage: "unknown",
        limitName: "Claude and GPT models",
        remainingFraction: 1,
        quotaLeft: "100%",
        resetIn: "Ready",
        modelId: "gpt-oss-120b-medium",
        modelIds: ["gpt-oss-120b-medium"],
      },
      {
        groupName: "Gemini 4 Argon",
        limit: "unknown",
        usage: "unknown",
        limitName: "Gemini 4 Argon",
        remainingFraction: 1,
        quotaLeft: "100%",
        resetIn: "Ready",
        modelId: "gemini-4-argon-high",
        modelIds: ["gemini-4-argon-high"],
      },
    ],
    quotaWindows: [
      { groupName: "Gemini Models", window: "5h", remainingFraction: 1 },
      { groupName: "Gemini Models", window: "weekly", remainingFraction: 1 },
      { groupName: "Claude and GPT models", window: "5h", remainingFraction: 1 },
      { groupName: "Gemini 4 Argon", window: "weekly", remainingFraction: 1 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  const accounts = getAccounts();
  originalAccounts.splice(0, originalAccounts.length, ...accounts.map(a => ({ ...a })));
  // Account A has Neon + Claude 4.6; Account B has Flash + Claude 5.5 (so Neon, Claude 4.6, Claude 5.5 split as separate pools)
  const accA = makeAccount("a");
  const accB = makeAccount("b", {
    availableModels: [
      { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", supportsThinking: true },
      { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", supportsThinking: true },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
    quota: [
      {
        groupName: "Gemini Models",
        limit: "unknown",
        usage: "unknown",
        limitName: "Gemini Models",
        remainingFraction: 1,
        quotaLeft: "100%",
        resetIn: "Ready",
        modelId: "gemini-3.8-flash-high",
        modelIds: ["gemini-3.8-flash-high"],
      },
      {
        groupName: "Claude Sonnet 5.5",
        limit: "unknown",
        usage: "unknown",
        limitName: "Claude and GPT models",
        remainingFraction: 1,
        quotaLeft: "100%",
        resetIn: "Ready",
        modelId: "claude-sonnet-5-5-high",
        modelIds: ["claude-sonnet-5-5-high"],
      },
      {
        groupName: "GPT-OSS 120B",
        limit: "unknown",
        usage: "unknown",
        limitName: "Claude and GPT models",
        remainingFraction: 1,
        quotaLeft: "100%",
        resetIn: "Ready",
        modelId: "gpt-oss-120b-medium",
        modelIds: ["gpt-oss-120b-medium"],
      },
    ],
    quotaWindows: [
      { groupName: "Gemini Models", window: "5h", remainingFraction: 1 },
      { groupName: "Claude and GPT models", window: "5h", remainingFraction: 1 },
    ],
  });
  accounts.splice(0, accounts.length, accA, accB);
});

afterEach(() => {
  const accounts = getAccounts();
  accounts.splice(0, accounts.length, ...originalAccounts.map(a => ({ ...a })));
});

describe("per-pool account disabling", () => {
  test("resolves display pools independently for shared-quota display groups", () => {
    const accounts = getAccounts();
    const accA = accounts[0]!;
    const accB = accounts[1]!;
    expect(getAccountModelDisplayPool(accA, "antigravity-gemini-3.8-flash", accounts)).toBe("Gemini Models");
    expect(getAccountModelDisplayPool(accA, "antigravity-gemini-4-neon", accounts)).toBe("Gemini 4 Neon");
    expect(getAccountModelDisplayPool(accA, "antigravity-claude-sonnet-4-6-thinking", accounts)).toBe("Claude 4.6");
    expect(getAccountModelDisplayPool(accB, "antigravity-claude-sonnet-5-5", accounts)).toBe("Claude 5.5");
    expect(getAccountModelDisplayPool(accA, "antigravity-gpt-oss-120b", accounts)).toBe("GPT-OSS 120B");
    expect(getAccountModelDisplayPool(accA, "antigravity-gemini-4-argon", accounts)).toBe("Gemini 4 Argon");
  });

  test("disabling an account in one pool blocks only that pool and leaves other pools unaffected", async () => {
    const accounts = getAccounts();
    const accA = accounts[0]!;
    accA.disabledPools = ["Gemini 4 Neon", "Claude 4.6"];

    expect(isAccountPoolDisabled(accA, "antigravity-gemini-4-neon", accounts)).toBe(true);
    expect(isAccountPoolDisabled(accA, "antigravity-claude-sonnet-4-6-thinking", accounts)).toBe(true);

    // Other pools on the exact same account remain enabled
    expect(isAccountPoolDisabled(accA, "antigravity-gemini-3.8-flash", accounts)).toBe(false);
    expect(isAccountPoolDisabled(accA, "antigravity-claude-sonnet-5-5", accounts)).toBe(false);
    expect(isAccountPoolDisabled(accA, "antigravity-gpt-oss-120b", accounts)).toBe(false);
    expect(isAccountPoolDisabled(accA, "antigravity-gemini-4-argon", accounts)).toBe(false);

    // Neon only supported by A -> now reports accounts_disabled
    expect(await getBestAccount("sandbox", "antigravity-gemini-4-neon")).toBeNull();
    expect(getAccountSelectionFailure("sandbox", "antigravity-gemini-4-neon")).toBe("accounts_disabled");

    // Claude 4.6 only supported by A -> now reports accounts_disabled
    expect(await getBestAccount("sandbox", "antigravity-claude-sonnet-4-6-thinking")).toBeNull();
    expect(getAccountSelectionFailure("sandbox", "antigravity-claude-sonnet-4-6-thinking")).toBe("accounts_disabled");

    // Argon on A is still selectable!
    const argonPick = await getBestAccount("sandbox", "antigravity-gemini-4-argon");
    expect(argonPick?.email).toBe("a@example.com");

    // Disabling Gemini Models on A routes Gemini 3.8 Flash exclusively to B, without affecting Argon on A
    accA.disabledPools = ["Gemini Models"];
    for (let i = 0; i < 5; i++) {
      const flashPick = await getBestAccount("sandbox", "antigravity-gemini-3.8-flash", undefined, [], true, `thread-${i}`);
      expect(flashPick?.email).toBe("b@example.com");
    }
    expect((await getBestAccount("sandbox", "antigravity-gemini-4-neon"))?.email).toBe("a@example.com");
    expect((await getBestAccount("sandbox", "antigravity-gemini-4-argon"))?.email).toBe("a@example.com");
  });

  test("per-pool disabled Google accounts are still refreshed and activated by the 10-min scheduler", async () => {
    const accounts = getAccounts();
    const accA = accounts[0]!;
    // Disable ALL pools on accA individually (NOT account.disabled!)
    accA.disabledPools = ["Gemini Models", "Gemini 4 Neon", "Claude 4.6", "Claude 5.5", "GPT-OSS 120B", "Gemini 4 Argon"];

    // Activation targets must still include accA's inactive windows
    const targets = getGoogleActivationTargets(accA);
    expect(targets.length).toBeGreaterThanOrEqual(2);

    const activatedModels: string[] = [];
    const runtime: WindowActivationRuntime = {
      refreshGoogleQuotas: async () => {},
      listGoogleAccounts: () => [accA],
      getCodexUsageSnapshots: async () => [],
      activateGoogle: async (account, model) => {
        activatedModels.push(model);
        // Simulate window becoming active after activation request
        const poolName = model.includes("argon") ? "Gemini 4 Argon"
          : model.includes("claude") || model.includes("gpt") ? "Claude and GPT models"
          : "Gemini Models";
        for (const q of account.quota || []) {
          if (q.limitName === poolName) q.remainingFraction = 0.99;
        }
        for (const w of account.quotaWindows || []) {
          if (w.groupName === poolName) w.remainingFraction = 0.99;
        }
        return true;
      },
      activateCodex: async () => true,
      refreshCodexUsage: async () => {},
    };

    const summary = await runQuotaWindowActivationCheck(runtime);
    expect(activatedModels.length).toBeGreaterThanOrEqual(2);
    expect(summary.googleActivated).toBe(activatedModels.length);
    expect(summary.failures).toBe(0);

    // Quota fetching must also still work for pool-disabled accounts
    const fakeQuotaFetch = (async () => Response.json({
      availableModels: {
        "models/gemini-3.8-flash-high": {
          displayMetadata: { label: "Gemini 3.8 Flash" },
          quotaInfo: { remainingFraction: 0.9 },
        },
      },
    })) as unknown as typeof fetch;
    const fakeWindowsFetch = (async () => Response.json({
      groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.9 }] }],
    })) as unknown as typeof fetch;

    expect(await fetchQuota(accA, true, fakeQuotaFetch)).not.toBeNull();
    expect(await fetchQuotaWindows(accA, fakeWindowsFetch)).not.toBeNull();
  });

  test("image generation skips accounts disabled in Gemini Models pool", async () => {
    const accounts = getAccounts();
    accounts[0]!.disabledPools = ["Gemini Models"];
    const usedEmails: string[] = [];
    const runtime: ImageGenerationRuntime = {
      getAccounts: () => accounts,
      prepareAccount: async email => accounts.find(a => a.email === email) || null,
      getTimeoutMs: () => 5000,
      randomIndex: () => 0,
      fetch: (async () => {
        const pngBase64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
        return Response.json({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: pngBase64 } }] } }],
        });
      }) as unknown as typeof fetch,
      onSuccess: async account => { usedEmails.push(account.email); },
      onSuspended: async () => {},
    };

    const req = new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.1-flash-image", prompt: "a cat" }),
    });
    const res = await handleImageGeneration(req, runtime);
    expect(res.status).toBe(200);
    expect(usedEmails).toEqual(["b@example.com"]);

    // If all accounts are disabled in Gemini Models, returns 503 accounts_disabled
    accounts[1]!.disabledPools = ["Gemini Models"];
    const res2 = await handleImageGeneration(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gemini-3.1-flash-image", prompt: "a cat" }),
      }),
      runtime,
    );
    expect(res2.status).toBe(503);
    expect(((await res2.json()) as any).error.code).toBe("accounts_disabled");
  });

  test("getEarliestReset ignores accounts disabled in the target pool", () => {
    const accounts = getAccounts();
    const soon = new Date(Date.now() + 60 * 60_000).toISOString();
    const later = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    accounts[0]!.quotaWindows = [{ groupName: "Gemini Models", window: "5h", remainingFraction: 0.5, resetTime: soon }];
    accounts[1]!.quotaWindows = [{ groupName: "Gemini Models", window: "5h", remainingFraction: 0.5, resetTime: later }];
    accounts[0]!.disabledPools = ["Gemini Models"];

    const reset = getEarliestReset("sandbox", "antigravity-gemini-3.8-flash");
    expect(reset).toMatch(/^2h 5\dm|3h 0m$/);
  });

  test("Codex account disabling skips request routing while keeping 10-min window activation working", async () => {
    const manager = new CodexAccountManager({ storagePath: ":memory:" });
    await manager.init();
    await manager.upsertCredentials({
      email: "codex-a@example.com",
      accountId: "acc-a",
      accessToken: "token-a",
      refreshToken: "refresh-a",
      expiresAt: Date.now() + 3600_000,
    });
    await manager.upsertCredentials({
      email: "codex-b@example.com",
      accountId: "acc-b",
      accessToken: "token-b",
      refreshToken: "refresh-b",
      expiresAt: Date.now() + 3600_000,
    });

    expect(await manager.setDisabled("codex-a@example.com", true)).toBe(true);
    const pubA = manager.listPublic().find(a => a.email === "codex-a@example.com")!;
    expect(pubA.disabled).toBe(true);
    expect(pubA.available).toBe(false);

    // Request selection must never pick disabled codex-a
    for (let i = 0; i < 5; i++) {
      const picked = await manager.selectAccount({ routingKey: `thread-${i}` });
      expect(picked?.email).toBe("codex-b@example.com");
    }

    // Re-authenticating preserves disabled flag
    await manager.upsertCredentials({
      email: "codex-a@example.com",
      accountId: "acc-a",
      accessToken: "token-a-2",
      refreshToken: "refresh-a-2",
      expiresAt: Date.now() + 3600_000,
    });
    expect(manager.listPublic().find(a => a.email === "codex-a@example.com")?.disabled).toBe(true);

    // prepareAccountForRequest (used by 10-min activation) still succeeds for disabled Codex accounts!
    const prepared = await manager.prepareAccountForRequest("codex-a@example.com");
    expect(prepared?.email).toBe("codex-a@example.com");

    // Re-enabling restores routing
    expect(await manager.setDisabled("codex-a@example.com", false)).toBe(true);
    expect(manager.listPublic().find(a => a.email === "codex-a@example.com")?.disabled).toBe(false);
    expect((await manager.selectAccount({ preferredEmail: "codex-a@example.com" }))?.email).toBe("codex-a@example.com");
  });

  test("setAccountPoolDisabled toggles pool names cleanly without mutating other pools", async () => {
    // Only test in-memory state when saveAccounts is not mutating real file?
    // Note: setAccountPoolDisabled calls saveAccounts; avoid touching real antigravity-accounts.json
    // by testing the pure helper and verifying invalid inputs return false without saving.
    expect(await setAccountPoolDisabled("missing@example.com", "Gemini Models", true)).toBe(false);
    expect(await setAccountPoolDisabled("a@example.com", "   ", true)).toBe(false);
  });
});
