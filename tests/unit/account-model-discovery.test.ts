import { describe, expect, test } from "bun:test";
import { evaluateAccountModelQuotaState, fetchQuota, parseQuotaResponse } from "../../src/api/quota";
import { getGoogleActivationTargets, runQuotaWindowActivationCheck } from "../../src/api/window-activation";
import { getAccounts, getBestAccount, getAccountSelectionFailure } from "../../src/auth/manager";
import type { AntigravityAccount } from "../../src/auth/types";
import { accountSupportsModel, findAccountModel, getAccountModelPool, getAccountQuotaWindows, getAvailableModelCatalog, updateQuotaFamilies } from "../../src/models";
import { transformCompletionToGoogleBody, validateCompletionRequestForGoogle } from "../../src/utils/transform";

const model = (id: string, fraction = 1, limitName?: string) => ({
  displayName: id.replace(/-/g, " "), supportsThinking: true, maxOutputTokens: 8192,
  quotaInfo: { remainingFraction: fraction, limitName, resetTime: "3600s" },
});
const account = (): AntigravityAccount => ({
  email: "discovery@example.com", refreshToken: "refresh", accessToken: "access", projectId: "project",
  expiresAt: Date.now() + 3600_000, healthScore: 100, lastUsed: 0, tokenUsage: 0,
});
async function discover(models: Record<string, any>) {
  const a = account();
  a.quota = (await fetchQuota(a, false, (async () => Response.json({ models })) as unknown as typeof fetch))!;
  return a;
}

describe("account-specific models and quotas", () => {
  test("handles array discovery, clears stale rejections, and preserves discovery after a failed refresh", async () => {
    const a = account();
    a.capabilities = { "antigravity-gemini-4-argon": false };
    const fetchModels = (value: unknown) => (async () => Response.json(value)) as unknown as typeof fetch;
    await fetchQuota(a, false, fetchModels({ availableModels: [{ name: "models/gemini-4-argon-high", ...model("Gemini-4-Argon") }] }));
    expect(accountSupportsModel(a, "antigravity-gemini-4-argon")).toBe(true);
    expect(await fetchQuota(a, false, fetchModels({ error: "unavailable" }))).toBeNull();
    expect(accountSupportsModel(a, "antigravity-gemini-4-argon")).toBe(true);
    expect(await fetchQuota(a, false, fetchModels({ models: {} }))).toEqual([]);
    expect(accountSupportsModel(a, "antigravity-gemini-4-argon")).toBe(false);
  });

  test("discovers enabled Argon tiers, preserves every quota member, and exposes a base alias", async () => {
    const a = await discover({
      "gemini-4-argon-high": model("Gemini-4-Argon", 0.75, "argon"),
      "gemini-4-argon-low": model("Gemini-4-Argon", 0.75, "argon"),
      "gemini-4-argon-disabled": { ...model("Gemini-4-Argon"), disabled: true },
      "claude-opus-5-5-high": model("Claude-Opus-5-5-High"),
      "gemini-internal": { ...model("Gemini-Internal"), isInternal: true },
    });
    expect(a.availableModels?.map(m => m.id)).toEqual(["gemini-4-argon-high", "gemini-4-argon-low", "claude-opus-5-5-high"]);
    expect(a.quota?.find(q => q.limitName === "argon")?.modelIds).toEqual(["gemini-4-argon-high", "gemini-4-argon-low"]);
    expect(getAvailableModelCatalog([a]).find(m => m.id === "antigravity-gemini-4-argon")).toMatchObject({
      thinkingLevels: ["low", "high"], defaultThinkingLevel: "high",
    });
    expect(accountSupportsModel(a, "openai/antigravity-gemini-4-argon")).toBe(true);
    expect(accountSupportsModel(a, "antigravity-gemini-4-argon-medium")).toBe(false);
    expect(getAvailableModelCatalog([{ ...a, disabled: true }]).some(m => m.id.includes("argon"))).toBe(false);
  });

  test("routes base aliases by effort and preserves discovered Gemini and Claude tier IDs", async () => {
    const a = await discover({
      "gemini-4-argon-low": model("Gemini-4-Argon"),
      "gemini-4-argon-high": model("Gemini-4-Argon"),
      "claude-opus-5-5-high": model("Claude-Opus-5-5-High"),
    });
    for (const [id, effort, upstream] of [
      ["antigravity-gemini-4-argon", "low", "gemini-4-argon-low"],
      ["antigravity-gemini-4-argon", "high", "gemini-4-argon-high"],
      ["antigravity-claude-opus-5-5", "high", "claude-opus-5-5-high"],
    ]) {
      const body = transformCompletionToGoogleBody({ model: id!, reasoningEffort: effort, messages: [{ role: "user", content: "hi" }], stream: false, maxOutputTokens: 99999 }, "project", "", undefined, false, findAccountModel(a, id!, effort));
      expect(body.model).toBe(upstream);
      expect(body.request.generationConfig.maxOutputTokens).toBe(8192);
      if (id!.includes("gemini")) expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe(effort!.toUpperCase());
    }
  });

  test("keeps dedicated weekly windows separate from the shared Gemini windows", async () => {
    const a = await discover({ "gemini-3-flash": model("Gemini-3-Flash"), "gemini-4-argon-high": model("Gemini-4-Argon") });
    a.quotaWindows = [
      { groupName: "Gemini Models", window: "5h", remainingFraction: 0 },
      { groupName: "Gemini Models", window: "weekly", remainingFraction: 0 },
      { groupName: "Gemini 4 Argon", window: "weekly", remainingFraction: 0.5 },
    ];
    expect(getAccountQuotaWindows(a, "antigravity-gemini-4-argon").map(w => w.remainingFraction)).toEqual([0.5]);
    expect(getAccountQuotaWindows(a, "gemini-3-flash").map(w => w.remainingFraction)).toEqual([0, 0]);
    const original = [...getAccounts()];
    try {
      getAccounts().splice(0, getAccounts().length, { ...a, email: "ordinary@example.com", availableModels: a.availableModels!.filter(m => !m.id.includes("argon")) }, a);
      expect((await getBestAccount("sandbox", "antigravity-gemini-4-argon"))?.email).toBe(a.email);
      a.quotaWindows[2]!.remainingFraction = 0;
      expect(await getBestAccount("sandbox", "antigravity-gemini-4-argon", undefined, [], false)).toBeNull();
      expect(getAccountSelectionFailure("sandbox", "antigravity-gemini-4-argon")).toBe("insufficient_quota");
    } finally { getAccounts().splice(0, getAccounts().length, ...original); }
  });

  test("routes Neon and its Orchestrator only through eligible accounts with shared Gemini quota", async () => {
    const base = "antigravity-gemini-4-neon";
    const orchestrator = "gemini-pro-orchestrator-neon";
    const neon = await discover(Object.fromEntries([
      ["gemini-4-neon-low", 1], ["gemini-4-neon-medium", 2], ["gemini-4-neon-high", 3],
      ["gemini-4-neon-xhigh", 100], [orchestrator, 100],
    ].map(([id, tier]) => [id, { ...model(String(id), 0.9), thinkingLevel: tier }])));
    const other = await discover({
      "gemini-4-neon-disabled": { ...model("Gemini 4 Neon"), disabled: true },
      "gemini-4-hydrogen-sonar": model("Hydrogen Sonar"),
    });
    other.email = "sonar-only@example.com";
    const now = Date.now();
    neon.quotaUpdatedAt = neon.quotaWindowsUpdatedAt = now;
    neon.quotaWindows = [
      { groupName: "Gemini Models", window: "5h", remainingFraction: 0.9 },
      { groupName: "Gemini Models", window: "weekly", remainingFraction: 0 },
      { groupName: "Gemini 4 Argon", window: "weekly", remainingFraction: 1 },
    ];
    // Account storage can still have the family from before the mapping fix.
    const highQuota = neon.quota!.find(q => q.modelId === "gemini-4-neon-high")!;
    highQuota.familyName = "Gemini 4 Neon";
    highQuota.remainingFraction = 0;
    for (const id of [base, orchestrator]) {
      expect(getAccountModelPool(neon, id)).toBe("Gemini Models");
      expect(getAccountQuotaWindows(neon, id).map(window => window.window)).toEqual(["5h", "weekly"]);
      expect(evaluateAccountModelQuotaState(neon, id, "xhigh", now).confirmedExhausted).toBe(true);
      expect(accountSupportsModel(other, id, "xhigh")).toBe(false);
    }
    const catalog = getAvailableModelCatalog([neon, other]);
    expect(catalog.find(m => m.id === base)?.thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(catalog.find(m => m.id === `antigravity-${orchestrator}`)?.thinkingLevels).toEqual(["xhigh"]);
    const original = [...getAccounts()];
    try {
      getAccounts().splice(0, getAccounts().length, other, neon);
      for (const id of [base, orchestrator]) {
        expect(await getBestAccount("sandbox", id, undefined, [], false, undefined, undefined, "xhigh")).toBeNull();
        expect(getAccountSelectionFailure("sandbox", id, "xhigh")).toBe("insufficient_quota");
      }
      neon.quotaWindows[1]!.remainingFraction = 1;
      for (const [id, expectedRoute] of [[base, "gemini-4-neon-xhigh"], [orchestrator, orchestrator]] as const) {
        const selected = await getBestAccount("sandbox", id, undefined, [], false, undefined, undefined, "xhigh");
        expect(selected?.email).toBe(neon.email);
        const request = { model: id, reasoningEffort: "xhigh", messages: [{ role: "user", content: "Reply OK." }], stream: true };
        const body = transformCompletionToGoogleBody(request, "project", "", undefined, false, findAccountModel(selected!, id, "xhigh"));
        expect(body.model).toBe(expectedRoute);
        expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe(100);
      }
    } finally { getAccounts().splice(0, getAccounts().length, ...original); }
    expect(validateCompletionRequestForGoogle({ model: orchestrator, messages: [{ role: "assistant", content: "Continue" }], stream: true })).toContain("cannot end with a model/assistant turn");
  });

  test("uses the native GPT-OSS thinking budget after discovery", async () => {
    const a = await discover({ "gpt-oss-120b-medium": model("GPT-OSS-120B") });
    const body = transformCompletionToGoogleBody({
      model: "antigravity-gpt-oss-120b", messages: [{ role: "user", content: "hi" }], stream: false,
    }, "project", "", undefined, false, findAccountModel(a, "antigravity-gpt-oss-120b"));
    expect(body.model).toBe("gpt-oss-120b-medium");
    expect(body.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 8192 });
  });

  test("derives an arbitrary dedicated pool from the summary rather than a Gemini generation whitelist", async () => {
    const a = await discover({ "gemini-3-special-high": model("Gemini-3-Special-High") });
    a.quota![0]!.groupName = "Gemini 3 Special (High)";
    a.quotaWindows = [
      { groupName: "Gemini Models", window: "5h", remainingFraction: 0 },
      { groupName: "Gemini 3 Special", window: "weekly", remainingFraction: 1 },
    ];
    updateQuotaFamilies(a);
    expect(a.quota![0]!.familyName).toBe("Gemini 3 Special");
    expect(getGoogleActivationTargets(a).map(t => t.key)).toEqual(["Gemini 3 Special"]);
  });

  test("activates unused Claude/GPT and Argon pools independently, preferring GPT-OSS over Opus", async () => {
    const a = await discover({
      "gemini-3-flash": model("Gemini-3-Flash", 0.8),
      "gemini-4-argon-high": model("Gemini-4-Argon"),
      "gemini-4-argon-low": model("Gemini-4-Argon"),
      "claude-opus-4-6-thinking": model("Claude-Opus-4-6"),
      "gpt-oss-120b-medium": model("GPT-OSS-120B"),
    });
    a.quotaWindows = [
      { groupName: "Gemini Models", window: "5h", remainingFraction: 0.8 },
      { groupName: "Gemini 4 Argon", window: "weekly", remainingFraction: 1 },
      { groupName: "Claude and GPT models", window: "5h", remainingFraction: 1 },
      { groupName: "Claude and GPT models", window: "weekly", remainingFraction: 0.5 },
    ];
    const activated: string[] = [];
    const summary = await runQuotaWindowActivationCheck({
      refreshGoogleQuotas: async () => {}, listGoogleAccounts: () => [a], getCodexUsageSnapshots: async () => [],
      activateGoogle: async (_, id) => {
        activated.push(id);
        // A successful activation includes refreshed quota evidence.
        a.quotaWindows![id.startsWith('gpt-oss') ? 2 : 1]!.remainingFraction = 0.99;
        return true;
      },
      activateCodex: async () => true, refreshCodexUsage: async () => {},
    });
    expect(activated).toEqual(["gpt-oss-120b-medium", "gemini-4-argon-high"]);
    expect(summary.googleActivated).toBe(2);
    a.quotaWindows[2]!.remainingFraction = 0.99;
    a.quotaWindows[1]!.remainingFraction = 0;
    expect(getGoogleActivationTargets(a)).toEqual([]);
  });

  test("retains the worst shared quota and its reset even when the first member is full", () => {
    const quotas = parseQuotaResponse({ models: {
      "gemini-4-argon-low": model("Gemini-4-Argon-Low", 1, "argon"),
      "gemini-4-argon-high": model("Gemini-4-Argon-High", 0.1, "argon"),
    } });
    expect(quotas).toHaveLength(1);
    expect(quotas![0]).toMatchObject({ remainingFraction: 0.1, windowActive: true, quotaLeft: "10%" });
    expect(quotas![0]!.resetTime).toBeDefined();
  });
});
