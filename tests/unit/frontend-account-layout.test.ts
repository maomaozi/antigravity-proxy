import { describe, expect, test } from "bun:test";
import "../../src/frontend/js/model-display.js";

const header = await Bun.file(new URL("../../src/frontend/components/header.html", import.meta.url)).text();
const main = await Bun.file(new URL("../../src/frontend/components/main.html", import.meta.url)).text();
const app = await Bun.file(new URL("../../src/frontend/js/app.js", import.meta.url)).text();
const server = await Bun.file(new URL("../../src/server.ts", import.meta.url)).text();
const sessions = await Bun.file(new URL("../../src/frontend/js/sessions.js", import.meta.url)).text();
const sessionsPage = await Bun.file(new URL("../../src/frontend/sessions.html", import.meta.url)).text();

const defaultDisplay = await Bun.file(new URL("../../src/config/model-display-defaults.json", import.meta.url)).json();

function createCodexQuotaHarness(display = defaultDisplay) {
  (globalThis as any).AntigravityModelDisplay.configure(display);
  (globalThis as any).AntigravityModelDisplay.setAccounts([]);
  const elements = new Map<string, { innerHTML: string }>();
  return new Function("window", "document", `${app}
    return {
      google(accounts, family) {
        modelDisplay.setAccounts(accounts);
        const pool = getFamilyName(family, accounts[0]);
        return { windows: getGoogleQuotaWindows(accounts[0], pool), stats: getGoogleWindowStats(accounts, pool), family: getFamilyQuotaData(accounts, pool) };
      },
      families(accounts) { return calculateFamilyStats(accounts); },
      renderGoogle(accounts) {
        renderAccountsTable(accounts);
        return document.getElementById('accounts-table-body').innerHTML;
      },
      renderPools(accounts) {
        globalAccounts = accounts;
        globalModelNames = new Map(accounts.flatMap(account => (account.availableModels || []).map(model => [model.id, model.name])));
        renderFamilyGrid(calculateFamilyStats(accounts));
        return document.getElementById('family-grid').innerHTML;
      },
      calculate(accounts) {
        globalCodexAccounts = accounts;
        globalCodexModels = ["gpt-5-codex"];
        currentConfig = { codex: { enabled: true } };
        return calculateCodexFamilyStat();
      }
    };
  `)({}, { getElementById(id: string) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '' });
    return elements.get(id);
  } });
}

describe("dashboard account provider layout", () => {
  test('separates restricted Hydrogen accounts without inventing a separate quota pool', () => {
    const accounts = [
      { email: 'full@example.com', healthScore: 100,
        quota: [{ modelIds: ['gemini-3.8-flash-high', 'gemini-4-hydrogen-high'], groupName: 'Gemini Models', remainingFraction: 0.6 }],
        quotaWindows: [
          { groupName: 'Gemini Models', window: '5h', remainingFraction: 0.8 },
          { groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.6 },
        ],
      },
      { email: 'standard@example.com', healthScore: 100,
        quota: [{ modelId: 'gemini-3.8-flash-high', groupName: 'Gemini 3.8 Flash', remainingFraction: 0.2 }],
        quotaWindows: [{ groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.2 }],
      },
    ];
    const harness = createCodexQuotaHarness();
    const stats = harness.families(accounts);
    const hydrogen = stats.find((stat: any) => stat.name === 'Gemini 4 Hydrogen');
    expect(hydrogen).toMatchObject({ total: 1, availability: 60, quotaPools: ['Gemini Models'] });
    expect(hydrogen.familyData.accounts.map((row: any) => row.email)).toEqual(['full@example.com']);
    expect(hydrogen.windowStats).toMatchObject([{ label: '5h', availability: 80 }, { label: '7d', availability: 60 }]);
    expect(stats.find((stat: any) => stat.name === 'Gemini Models')).toMatchObject({ total: 2, availability: 40 });
    const html = harness.renderPools(accounts);
    expect(html).toContain('Shared quota: Gemini Models');
    expect(harness.renderGoogle(accounts).split('standard@example.com')[1]).not.toContain('Gemini 4 Hydrogen');
    expect(accounts[0]!.quota[0]).toMatchObject({ modelIds: ['gemini-3.8-flash-high', 'gemini-4-hydrogen-high'] });
  });

  test('lets configuration merge, always split, or conditionally split the same models', () => {
    const accounts = ['a', 'b'].map(name => ({ email: `${name}@example.com`, healthScore: 100,
      quota: ['gemini-3.8-flash-high', 'gemini-4-hydrogen-high'].map(modelId => ({ modelId, groupName: modelId, remainingFraction: 0.5 })),
      quotaWindows: [{ groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.5 }],
    }));
    expect(createCodexQuotaHarness().families(accounts).map((stat: any) => stat.name)).toEqual(['Gemini Models']);
    const always = { ...defaultDisplay, groups: [{ ...defaultDisplay.groups[0], separateWhen: 'always' }] };
    expect(createCodexQuotaHarness(always).families(accounts).map((stat: any) => stat.name)).toEqual(['Gemini Models', 'Gemini 4 Hydrogen']);
    accounts[1]!.quota = accounts[1]!.quota.slice(0, 1);
    expect(createCodexQuotaHarness().families(accounts).map((stat: any) => stat.name)).toEqual(['Gemini Models', 'Gemini 4 Hydrogen']);
    expect(createCodexQuotaHarness({ ...defaultDisplay, groups: [] }).families(accounts).map((stat: any) => stat.name)).toEqual(['Gemini Models']);
  });

  test('applies grouping policies to arbitrary future model IDs and group names', () => {
    const policy = {
      visibility: { showPatterns: [], hidePatterns: [] },
      poolRules: [{ patterns: ['^future-'], pools: ['Shared compute'] }],
      groups: [{ name: 'Restricted preview', patterns: ['^future-preview$'], separateWhen: 'different-accounts' }],
      groupOrder: ['Restricted preview', 'Shared compute'],
    };
    const accounts = [
      { email: 'preview@example.com', quota: [{ modelId: 'future-preview', groupName: 'Preview', remainingFraction: 0.4 }, { modelId: 'future-common', groupName: 'Common', remainingFraction: 0.4 }], quotaWindows: [{ groupName: 'Shared compute', window: 'weekly', remainingFraction: 0.4 }] },
      { email: 'common@example.com', quota: [{ modelId: 'future-common', groupName: 'Common', remainingFraction: 0.8 }], quotaWindows: [{ groupName: 'Shared compute', window: 'weekly', remainingFraction: 0.8 }] },
    ];
    const stats = createCodexQuotaHarness(policy).families(accounts);
    expect(stats.map((stat: any) => [stat.name, stat.total, stat.availability])).toEqual([['Restricted preview', 1, 40], ['Shared compute', 2, 60]]);
    expect(stats[0].quotaPools).toEqual(['Shared compute']);
  });

  test('counts each account once per period when a configured group covers several quota pools', () => {
    const policy = { ...defaultDisplay, groups: [{ name: 'Combined view', patterns: ['.'], separateWhen: 'always' }] };
    const accounts = [
      { email: 'two-pools@example.com', healthScore: 100,
        quota: [{ modelId: 'gemini-3.8-flash-high', groupName: 'Flash', remainingFraction: 0.8 }, { modelId: 'claude-sonnet-5-5-high', groupName: 'Sonnet', remainingFraction: 0.2 }],
        quotaWindows: [{ groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.8 }, { groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: 0.2 }],
      },
      { email: 'one-pool@example.com', healthScore: 100,
        quota: [{ modelId: 'gemini-3.8-flash-high', groupName: 'Flash', remainingFraction: 0.9 }],
        quotaWindows: [{ groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.9 }],
      },
    ];
    const stats = createCodexQuotaHarness(policy).families(accounts);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ total: 2, availability: 55, windowStats: [{ label: '7d', availability: 55 }] });
    expect(stats[0].familyData.accounts[0].windows).toHaveLength(1);
  });

  test('merges shared model tiers once per account and displays Orchestrator under the dedicated Argon pool', () => {
    const account = {
      email: 'shared@example.com', healthScore: 100,
      availableModels: [{ id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' }],
      quota: [
        { modelId: 'gemini-3.8-flash-high', groupName: 'Gemini 3.8 Flash (High)', remainingFraction: 0.8 },
        { modelId: 'gemini-4-hydrogen-xhigh', groupName: 'Gemini 4 Hydrogen (XHigh)', familyName: 'Gemini 4 Hydrogen', remainingFraction: 0.8 },
        { modelId: 'gemini-3.1-flash-image', groupName: 'Gemini 3.1 Flash Image', remainingFraction: 0.8 },
        { modelId: 'gemini-3.5-flash-lite', groupName: 'Gemini 3.5 Flash Lite', remainingFraction: 0 },
        { modelId: 'gemini-2.5-pro', groupName: 'Gemini 2.5 Pro', remainingFraction: 0 },
        ...['claude-sonnet-5-5-high', 'claude-opus-5-5-low', 'gpt-oss-120b-medium'].map(modelId => ({ modelId, groupName: modelId, remainingFraction: 0.4 })),
        { modelId: 'gemini-4-argon-high', groupName: 'Gemini 4 Argon (High)', remainingFraction: 0.2 },
        { modelId: 'gemini-pro-orchestrator-g1-pro', groupName: 'Orchestrator (Argon)', familyName: 'Gemini Models', remainingFraction: 0.2 },
      ],
      quotaWindows: [
        { groupName: 'Gemini Models', window: '5h', remainingFraction: 0.8 },
        { groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.6 },
        { groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: 0.4 },
        { groupName: 'Gemini 4 Argon', window: 'weekly', remainingFraction: 0.2 },
      ],
    };
    const harness = createCodexQuotaHarness();
    const stats = harness.families([account]);
    expect(stats.map((stat: any) => [stat.name, stat.total, stat.availability])).toEqual([
      ['Gemini Models', 1, 60], ['Claude and GPT models', 1, 40], ['Gemini 4 Argon', 1, 20],
    ]);
    expect(harness.google([account], 'Gemini 4 Hydrogen').family.accounts).toHaveLength(1);
    const html = harness.renderPools([account]);
    const argon = html.split('>Gemini 4 Argon</div>')[1];
    expect(argon).toContain('Orchestrator (Argon)');
    expect(html).toContain('gemini-3.1-flash-image');
    expect(html).not.toContain('3.5');
    expect(html).not.toContain('2.5');
    const details = harness.renderGoogle([account]);
    expect(details).not.toContain('Gemini 3.5');
    expect(details).not.toContain('Gemini 2.5');
  });

  test('merges Argon and Orchestrator into Gemini only on accounts whose summary has no dedicated Argon pool', () => {
    const accounts = [{
      email: 'combined@example.com', healthScore: 100,
      quota: ['gemini-4-argon-high', 'gemini-pro-orchestrator-g1-pro'].map(modelId => ({ modelId, groupName: modelId, remainingFraction: 0.5 })),
      quotaWindows: [{ groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.5 }],
    }];
    const stats = createCodexQuotaHarness().families(accounts);
    expect(stats.find((stat: any) => stat.name === 'Gemini Models')).toMatchObject({ total: 1, availability: 50 });
    expect(stats.some((stat: any) => stat.name === 'Gemini 4 Argon')).toBe(false);
  });

  test('shows suspended pools while leaving the account and other pools available', () => {
    const html = createCodexQuotaHarness().renderGoogle([{
      email:'pool@example.com', healthScore:100,
      quota:[{groupName:'Gemini 3.8 Flash',remainingFraction:1},{groupName:'Claude Sonnet 4.6',remainingFraction:1}],
      poolSuspensions:{'Claude and GPT models':{reason:'tos_violation',message:'<service disabled>',retryAt:Date.now()+600000,appealUrl:'javascript:alert(1)'}},
    }]);
    expect(html).toContain('1 POOL(S) SUSPENDED');
    expect(html).toContain('Status: SUSPENDED');
    expect(html).toContain('Status: OK');
    expect(html).toContain('&lt;service disabled&gt;');
    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('>DISABLED</span>');
  });

  test('aggregates each Google family over the same accounts shown in its expanded card', () => {
    const accounts = Array.from({ length: 6 }, (_, index) => ({
      email: `account-${index}@example.com`, healthScore: 100,
      quota: [
        { groupName: 'Gemini 3.8 Flash', remainingFraction: 1 },
        { groupName: index === 5 ? 'Claude Opus 5.5 (High)' : 'Claude Opus 4.6 (Thinking)', remainingFraction: 1 },
        { groupName: index === 5 ? 'Claude Sonnet 5.5 (High)' : 'Claude Sonnet 4.6 (Thinking)', remainingFraction: 1 },
        { groupName: 'GPT-OSS 120B (Medium)', remainingFraction: 1 },
        ...(index === 5 ? [{ groupName: 'Gemini 4 Argon (High)', remainingFraction: 1 }] : []),
      ],
      quotaWindows: [
        { groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.8 },
        { groupName: 'Claude and GPT models', window: '5h', remainingFraction: 1 },
        { groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: index === 2 ? 0.54 : 1 },
        // A quota summary can advertise a pool without exposing its models.
        { groupName: 'Gemini 4 Argon', window: 'weekly', remainingFraction: index === 5 ? 0.75 : 0 },
      ],
    }));
    const harness = createCodexQuotaHarness();
    const families = harness.families(accounts);
    for (const family of families) {
      const rows = harness.google(accounts, family.name).family.accounts;
      expect(family.total).toBe(rows.length);
      for (const window of family.windowStats) {
        const measured = rows.flatMap((row: any) => row.windows.filter((item: any) => item.label === window.label));
        expect(measured.length).toBeGreaterThan(0);
        expect(window.availability).toBe(Math.round(measured.reduce((sum: number, item: any) => sum + item.remainingFraction * 100, 0) / measured.length));
      }
    }
    expect(families.find((item: any) => item.name === 'Claude and GPT models')).toMatchObject({
      total: 6, availability: 92, windowStats: [{ label: '5h', availability: 100 }, { label: '7d', availability: 92 }],
    });
    expect(families.find((item: any) => item.name === 'Claude and GPT models').windowStats[1].availability).toBe(92);
    expect(families.find((item: any) => item.name === 'Claude and GPT models').windowStats[1].availability).toBe(92);
    expect(families.find((item: any) => item.name === 'Claude and GPT models').windowStats[1].availability).toBe(92);
    expect(families.find((item: any) => item.name === 'Gemini 4 Argon')).toMatchObject({
      total: 1, availability: 75, windowStats: [{ label: '7d', availability: 75 }],
    });
    expect(harness.families([]).every((item: any) => item.total === 0 && item.windowStats.length === 0)).toBe(true);
  });

  test('uses window resets and the same fallback percentage in account details and model cards', () => {
    const reset = Date.now() + 3 * 86400_000;
    const accounts = [{
      email: 'resets@example.com', healthScore: 100,
      quota: [
        { groupName: 'Claude Opus 5.5 (High)', remainingFraction: 1 },
        { groupName: 'Gemini 3.8 Flash', remainingFraction: 0.2 },
        { groupName: 'Gemini 3.8 Flash (High)', remainingFraction: 0.8 },
      ],
      quotaWindows: [
        { groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(reset).toISOString() },
      ],
    }];
    const harness = createCodexQuotaHarness();
    expect(harness.google(accounts, 'Claude Opus 5.5').family).toMatchObject({
      earliestReset: reset, accounts: [{ avgQuota: 40, resetTime: reset }],
    });
    expect(harness.families(accounts).find((item: any) => item.name === 'Gemini Models').availability).toBe(20);
    const html = harness.renderGoogle(accounts);
    expect(html).toMatch(/>20%<\/span>/);
    expect(html).not.toMatch(/>80%<\/span>/);
    const opus = html.split('Claude and GPT models')[1].split('Status: OK')[1];
    expect(opus.split('Quota resets in')[1].split('</span>')[1]).not.toContain('Ready');
  });

  test('weights Google accounts equally and rounds only after aggregating measured quotas', () => {
    const accounts = [{
      email: 'many-tiers@example.com', healthScore: 100,
      quota: ['High', 'Low', 'Medium'].map(tier => ({ groupName: `Claude Opus 5.5 (${tier})`, remainingFraction: 0.8049 })),
    }, {
      email: 'one-tier@example.com', healthScore: 40,
      quota: [{ groupName: 'Claude Opus 5.5 (High)', remainingFraction: 0.2051 }],
    }];
    const stat = createCodexQuotaHarness().families(accounts).find((item: any) => item.name === 'Claude and GPT models');
    expect(stat).toMatchObject({ availability: 51, total: 2, healthy: 1, windowStats: [] });
    expect(stat.familyData.accounts.map((item: any) => item.avgQuota)).toEqual([80, 21]);
  });

  test('keeps missing windows out of period averages and ignores reset dates for full windows', () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const accounts = [{
      email: 'with-windows@example.com', healthScore: 100,
      quota: [{ groupName: 'Claude Opus 5.5 (High)', remainingFraction: 1 }],
      quotaWindows: [
        { groupName: 'Claude and GPT models', window: '5h', remainingFraction: 1, resetTime: future },
        { groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: 0.4, resetTime: future },
      ],
    }, {
      email: 'no-summary@example.com', healthScore: 100,
      quota: [{ groupName: 'Claude Opus 5.5 (High)', remainingFraction: 0.8 }],
      quotaWindows: [],
    }];
    const harness = createCodexQuotaHarness();
    const stat = harness.families(accounts).find((item: any) => item.name === 'Claude and GPT models');
    expect(stat).toMatchObject({ availability: 60, total: 2, windowStats: [
      { label: '5h', availability: 100, earliestReset: null },
      { label: '7d', availability: 40, earliestReset: Date.parse(future) },
    ] });
    const html = harness.renderGoogle([accounts[0]]);
    expect(html).toContain('Ready');
    expect(harness.google([accounts[0]], 'Claude Opus 5.5').windows[0].resetTime).toBeNull();
  });

  test('shows Argon and newly discovered model families with their dedicated quotas', () => {
    const accounts = [{
      email: 'special@example.com', healthScore: 100,
      quota: [
        { groupName: 'Gemini 3.8 Flash', remainingFraction: 0.8 },
        { groupName: 'Gemini 4 Argon (High)', remainingFraction: 0.4, familyName: 'Gemini 4 Argon' },
        { groupName: 'Claude Opus 5.5 (High)', remainingFraction: 1 },
      ],
      quotaWindows: [
        { groupName: 'Gemini Models', window: '5h', remainingFraction: 0.8 },
        { groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.9 },
        { groupName: 'Gemini 4 Argon', window: 'weekly', remainingFraction: 0.4 },
        { groupName: 'Claude and GPT models', window: '5h', remainingFraction: 1 },
      ],
    }];
    const harness = createCodexQuotaHarness();
    expect(harness.google(accounts, 'Gemini 4 Argon').windows.map((item: any) => [item.label, item.remaining])).toEqual([['7d', 40]]);
    expect(harness.google(accounts, 'Gemini Models').windows.map((item: any) => item.remaining)).toEqual([80, 90]);
    expect(harness.families(accounts).find((item: any) => item.name === 'Gemini 4 Argon')).toMatchObject({ availability: 40, total: 1 });
    expect(harness.families(accounts).some((item: any) => item.name === 'Claude and GPT models')).toBe(true);
  });

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

  test("labels Google health and Codex quota in the account columns", () => {
    expect(main.match(/>Identity<\/th>/g)?.length).toBe(2);
    const googleSection = main.split('id="google-accounts-section"')[1].split('</section>')[0];
    const codexSection = main.split('id="codex-accounts-section"')[1].split('</section>')[0];
    expect(googleSection).toContain(">Health</th>");
    expect(codexSection).toContain(">Quota</th>");
    expect(codexSection).not.toContain(">Health</th>");
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
    expect(main).toContain("repeat(auto-fit,minmax(200px,1fr))");
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
    expect(main).toContain("repeat(auto-fit,minmax(200px,1fr))] items-start");
    expect(app).toContain("flex flex-col self-start");
    expect(app.includes("min-w-0 min-h-[3rem] shrink-0")).toBe(true);
    expect(app).not.toContain("flex flex-col h-full");
  });

});
