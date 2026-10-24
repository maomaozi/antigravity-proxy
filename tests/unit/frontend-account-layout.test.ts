import { describe, expect, test } from "bun:test";

const header = await Bun.file(new URL("../../src/frontend/components/header.html", import.meta.url)).text();
const main = await Bun.file(new URL("../../src/frontend/components/main.html", import.meta.url)).text();
const app = await Bun.file(new URL("../../src/frontend/js/app.js", import.meta.url)).text();
const server = await Bun.file(new URL("../../src/server.ts", import.meta.url)).text();
const sessions = await Bun.file(new URL("../../src/frontend/js/sessions.js", import.meta.url)).text();
const sessionsPage = await Bun.file(new URL("../../src/frontend/sessions.html", import.meta.url)).text();

function createCodexQuotaHarness() {
  return new Function("window", `${app}
    return {
      google(accounts, family) {
        return { windows: getGoogleQuotaWindows(accounts[0], family), stats: getGoogleWindowStats(accounts, family), family: getFamilyQuotaData(accounts, family) };
      },
      calculate(accounts) {
        globalCodexAccounts = accounts;
        globalCodexModels = ["gpt-5-codex"];
        currentConfig = { codex: { enabled: true } };
        return calculateCodexFamilyStat();
      }
    };
  `)({});
}

describe("dashboard account provider layout", () => {
  test('shows shared Google weekly quotas in the correct families and respects the tighter window', () => {
    const makeAccount = (weekly: number) => ({
      email: `weekly-${weekly}@example.com`,
      quota: [{ groupName: 'Gemini 3.8 Flash', remainingFraction: 0.9 }],
      quotaWindows: [
        { groupName: 'Gemini Models', window: 'weekly', remainingFraction: weekly },
        { groupName: 'Gemini Models', window: '5h', remainingFraction: 0.9 },
        { groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: 0 },
      ],
    });
    const harness = createCodexQuotaHarness();
    const gemini = harness.google([makeAccount(0.2), makeAccount(0.4)], 'Gemini Models');
    expect(gemini.windows.map((item: any) => item.label)).toEqual(['5h', '7d']);
    expect(gemini.stats.map((item: any) => item.availability)).toEqual([90, 30]);
    expect(gemini.family.accounts[0].avgQuota).toBe(20);
    for (const family of ['Claude Sonnet 4.6', 'Claude Opus 4.6', 'GPT-OSS 120B']) {
      expect(harness.google([makeAccount(0.2)], family).windows.map((item: any) => item.remaining)).toEqual([0]);
    }
    expect(harness.google([makeAccount(0.2)], 'Other').windows).toEqual([]);
  });

  test("keeps provider login actions out of the global header", () => {
    expect(header).not.toContain('href="/oauth/start"');
    expect(header).not.toContain("ADD ACCOUNT");
  });

  test("renders Google and Codex account pools at the same dashboard hierarchy", () => {
    expect(main).toContain('id="google-accounts-section"');
    expect(main).toContain('id="codex-accounts-section"');
    expect(main).toContain("Google Accounts");
    expect(main).toContain('href="/oauth/start"');
    expect(main).toContain("Add Google Account");
    expect(main).toContain("Add Codex Account");
    expect(main).not.toContain("Flush");
    expect(header).toContain('id="usage-refresh-button"');
    expect(header).toContain("Refresh usage");
    expect(main).not.toContain('id="usage-refresh-button"');
    expect(app).toContain("refreshUsageDisplay");
    expect(app).toContain("fetch('/api/status', { cache: 'no-store' })");
    expect(app).toContain("await loadCodexUsage(true)");
  });

  test("uses the same primary account columns for Google and Codex", () => {
    expect(main.match(/>Identity<\/th>/g)?.length).toBe(2);
    expect(main.match(/>Health<\/th>/g)?.length).toBe(2);
    expect(main.match(/>Last Active<\/th>/g)?.length).toBe(2);
    expect(main.match(/>Action<\/th>/g)?.length).toBe(2);
    expect(main).not.toContain(">Account ID</th>");
    expect(main).not.toContain(">Token</th>");
  });

  test("renders Codex quota windows with Google-style remaining bars", () => {
    expect(app).toContain("codexQuotaBarClass");
    expect(app).toContain("codexWindowIsActive");
    expect(app).toContain("remaining < duration - 5");
    expect(app).toContain("Resource Allocations");
    expect(app).toContain("toggleCodexAccount");
  });

  test("keeps 5-hour and 7-day Codex windows separate regardless of primary order", () => {
    const now = Date.now();
    const stat = createCodexQuotaHarness().calculate([{
      email: "quota@example.com",
      available: true,
      cooldownUntil: 0,
      usageFetchedAt: now,
      usage: {
        allowed: true,
        limitReached: false,
        primaryWindow: {
          usedPercent: 20,
          limitWindowSeconds: 7 * 24 * 60 * 60,
          resetAt: now + 6 * 24 * 60 * 60 * 1000,
          resetAfterSeconds: 6 * 24 * 60 * 60,
        },
        secondaryWindow: {
          usedPercent: 8,
          limitWindowSeconds: 5 * 60 * 60,
          resetAt: now + 2 * 60 * 60 * 1000,
          resetAfterSeconds: 2 * 60 * 60,
        },
      },
    }]);

    expect(stat.windowStats.map((window: any) => window.label)).toEqual(["5h", "7d"]);
    expect(stat.windowStats.map((window: any) => window.availability)).toEqual([92, 80]);
    expect(stat.familyData.accounts[0].windows.map((window: any) => window.label)).toEqual(["5h", "7d"]);
    expect(stat.availability).toBe(80);
  });

  test("supports Codex plans that report only one quota window", () => {
    const now = Date.now();
    const stat = createCodexQuotaHarness().calculate([{
      email: "single@example.com",
      available: true,
      cooldownUntil: 0,
      usageFetchedAt: now,
      usage: {
        allowed: true,
        limitReached: false,
        primaryWindow: {
          usedPercent: 10,
          limitWindowSeconds: 5 * 60 * 60,
          resetAt: now + 60 * 60 * 1000,
          resetAfterSeconds: 60 * 60,
        },
        secondaryWindow: null,
      },
    }]);

    expect(stat.windowStats).toHaveLength(1);
    expect(stat.windowStats[0]).toMatchObject({ label: "5h", availability: 90 });
  });

  test("counts active credentials across both providers instead of Google rows only", () => {
    expect(header).toContain('id="stat-active-accounts"');
    expect(app).toContain("updateAccountSummary");
    expect(app).toContain("googleAccounts.filter(isGoogleAccountActive)");
    expect(app).toContain("codexAccounts.filter(isCodexAccountActive)");
  });

  test("keeps Codex availability and last-active metadata fresh with quota refreshes", () => {
    expect(server).toContain("publicAccountsByEmail");
    expect(app).toContain("snapshot?.lastUsed");
    expect(app).toContain("snapshot?.cooldownUntil");
    expect(app).toContain("typeof snapshot?.available === 'boolean'");
    expect(app).toContain("!account.usage && account.available === false");
  });

  test("keeps last-active and cooldown-derived dashboard state fresh", () => {
    expect(app).toContain("lastActivityMap.get(acc.email) || Number(acc.lastUsed || 0)");
    expect(app).toContain("hasActiveCooldowns || hadActiveCooldowns");
    expect(app).toContain("renderDashboardFamilies();");
    expect(app).toContain("updateAccountSummary();");
  });

  test("counts active sessions rather than active model bindings on the sessions page", () => {
    expect(sessionsPage).toContain("Active Sessions · 1h");
    expect(sessions).toContain(".map(row => row.sessionKey)");
  });

  test("uses family-aware Google cooldown keys in dashboard status", () => {
    expect(app).toContain('`${email}|sandbox|${category}`');
  });

  test("includes configured Codex models in the top family cards", () => {
    expect(app).toContain("globalCodexModels");
    expect(app).toContain("Codex Models");
    expect(app).toContain("calculateCodexFamilyStat");
    expect(app).toContain("renderDashboardFamilies");
    expect(main).toContain("lg:grid-cols-5");
  });
  test("keeps mobile dashboard on natural document scrolling", async () => {
    const index = await Bun.file(new URL("../../src/frontend/index.html", import.meta.url)).text();
    expect(index).toContain("min-h-full lg:h-full");
    expect(index).toContain("lg:overflow-hidden");
    expect(index).not.toContain("h-[calc(100vh-4rem)]");
    expect(main).toContain("lg:overflow-y-auto");
    expect(main).not.toContain('<div class="flex-grow overflow-y-auto bg-zinc-50');
    expect(main).toContain('id="logs-resizer" class="hidden lg:block');
  });

  test("expands one metric family when its card is tapped", () => {
    expect(app).toContain('onclick="toggleFamily(${index})"');
  });

  test("keeps expanded metric quota bars visible in narrow cards", () => {
    expect(app).toContain("grid-cols-[minmax(0,72px)_minmax(36px,1fr)_max-content]");
    expect(app).toContain("sm:grid-cols-[minmax(0,88px)_minmax(48px,1fr)_max-content]");
    expect(app).not.toContain("grid-cols-[100px_1fr_85px]");
  });

  test("renders Codex 5h and 7d as separate progress bars", () => {
    expect(app).toContain("formatCompactReset");
    expect(app).toContain('w-full space-y-1.5');
    expect(app).toContain("codexQuotaBarClass(window.availability)");
    expect(app).toContain("grid grid-cols-1 items-center gap-2");
    expect(app).toContain("grid-cols-[20px_minmax(0,1fr)_26px_44px]");
    expect(app).toContain("codexQuotaBarClass(window.remaining)");
  });

  test("keeps family cards aligned while expanding independently", () => {
    expect(main).toContain("lg:grid-cols-5 items-start");
    expect(app).toContain("flex flex-col self-start");
    expect(app).toContain("min-w-0 h-12 shrink-0 overflow-hidden");
    expect(app).not.toContain("flex flex-col h-full");
  });

});
