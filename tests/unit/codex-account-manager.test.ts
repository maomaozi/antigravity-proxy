import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAccountManager } from "../../src/codex/account-manager";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "codex-account-manager-"));
  dirs.push(dir);
  return join(dir, "accounts.json");
}

describe("CodexAccountManager", () => {
  test("persists credentials separately and exposes token-free public account state", async () => {
    const path = tempFile();
    const manager = new CodexAccountManager({ storagePath: path });
    await manager.init();
    await manager.upsertCredentials({
      email: "one@example.com",
      accountId: "acct_1",
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      idToken: "secret-id",
      expiresAt: Date.now() + 3600_000,
    });
    expect(manager.listPublic()).toEqual([expect.objectContaining({
      email: "one@example.com",
      accountId: "acct_1",
      available: true,
    })]);
    expect(JSON.stringify(manager.listPublic())).not.toContain("secret-access");

    const reloaded = new CodexAccountManager({ storagePath: path });
    await reloaded.init();
    expect(reloaded.listPublic()[0].email).toBe("one@example.com");
  });

  test("honors sticky preferred account, then rotates when it is cooling down", async () => {
    let now = 1000;
    const manager = new CodexAccountManager({ storagePath: tempFile(), now: () => now });
    await manager.init();
    await manager.upsertCredentials({ email: "a@example.com", accountId: "a", accessToken: "a", refreshToken: "ra", expiresAt: 999999 });
    await manager.upsertCredentials({ email: "b@example.com", accountId: "b", accessToken: "b", refreshToken: "rb", expiresAt: 999999 });

    expect((await manager.selectAccount({ preferredEmail: "b@example.com" }))?.email).toBe("b@example.com");
    await manager.markCooldown("b@example.com", 30_000);
    expect((await manager.selectAccount({ preferredEmail: "b@example.com" }))?.email).toBe("a@example.com");
    now += 31_000;
    expect((await manager.selectAccount({ preferredEmail: "b@example.com" }))?.email).toBe("b@example.com");
  });

  test("uses stable rendezvous routing for a routing key", async () => {
    const manager = new CodexAccountManager({ storagePath: ":memory:" });
    await manager.init();
    for (const name of ["a", "b", "c", "d"]) {
      await manager.upsertCredentials({
        email: `${name}@example.com`,
        accountId: name,
        accessToken: name,
        refreshToken: `r${name}`,
        expiresAt: Date.now() + 3600_000,
      });
    }

    const first = await manager.selectAccount({ routingKey: "thread-123" });
    const second = await manager.selectAccount({ routingKey: "thread-123" });
    expect(first?.email).toBeTruthy();
    expect(second?.email).toBe(first?.email);
  });

  test("rendezvous routing spreads independent threads across the available pool", async () => {
    const manager = new CodexAccountManager({ storagePath: ":memory:" });
    await manager.init();
    for (const name of ["a", "b", "c", "d"]) {
      await manager.upsertCredentials({
        email: `${name}@example.com`,
        accountId: name,
        accessToken: name,
        refreshToken: `r${name}`,
        expiresAt: Date.now() + 3600_000,
      });
    }

    const selected = new Set<string>();
    for (let index = 0; index < 64; index++) {
      const account = await manager.selectAccount({ routingKey: `thread-${index}` });
      if (account) selected.add(account.email);
    }
    expect(selected.size).toBeGreaterThanOrEqual(3);
  });

  test("refreshes expired tokens using the Codex OAuth refresh flow and rotates refresh token", async () => {
    let requestBody = "";
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body || "");
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });
    };
    const manager = new CodexAccountManager({ storagePath: tempFile(), fetchImpl: fakeFetch as typeof fetch, now: () => 10_000 });
    await manager.init();
    await manager.upsertCredentials({ email: "a@example.com", accountId: "a", accessToken: "old", refreshToken: "old-refresh", expiresAt: 9_000 });

    const selected = await manager.selectAccount({ preferredEmail: "a@example.com" });
    expect(selected?.accessToken).toBe("new-access");
    expect(requestBody).toContain("grant_type=refresh_token");
    expect(requestBody).toContain("refresh_token=old-refresh");
  });
});

test("fetches WHAM quota usage with Codex account headers and normalizes reset windows", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 31,
          limit_window_seconds: 7 * 24 * 60 * 60,
          reset_at: 1_800_000_000,
          reset_after_seconds: 1234,
        },
        secondary_window: {
          used_percent: 8,
          limit_window_seconds: 5 * 60 * 60,
          reset_at: 1_700_000_100_000,
        },
      },
      credits: { balance: "12.5", has_credits: true, unlimited: false },
    });
  };
  const manager = new CodexAccountManager({
    storagePath: tempFile(),
    fetchImpl: fakeFetch as typeof fetch,
    now: () => 1_700_000_000_000,
  });
  await manager.init();
  await manager.upsertCredentials({
    email: "quota@example.com",
    accountId: "acct_quota",
    accessToken: "quota-token",
    refreshToken: "refresh-token",
    expiresAt: 1_700_003_600_000,
  });

  const snapshots = await manager.getUsageSnapshots();

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://chatgpt.com/backend-api/wham/usage");
  expect(calls[0].init?.method).toBe("GET");
  expect(calls[0].init?.headers).toEqual(expect.objectContaining({
    Authorization: "Bearer quota-token",
    "ChatGPT-Account-Id": "acct_quota",
    "User-Agent": "codex-cli",
  }));
  expect(snapshots).toEqual([expect.objectContaining({
    email: "quota@example.com",
    accountId: "acct_quota",
    error: null,
    usage: expect.objectContaining({
      planType: "plus",
      allowed: true,
      limitReached: false,
      primaryWindow: expect.objectContaining({
        usedPercent: 31,
        limitWindowSeconds: 604800,
        resetAt: 1_800_000_000_000,
        resetAfterSeconds: 1234,
      }),
      secondaryWindow: expect.objectContaining({
        usedPercent: 8,
        limitWindowSeconds: 18000,
        resetAt: 1_700_000_100_000,
      }),
      credits: { balance: "12.5", hasCredits: true, unlimited: false },
    }),
  })]);
  expect(JSON.stringify(snapshots)).not.toContain("quota-token");
});

test("refreshes once and retries WHAM usage after a 401", async () => {
  const calls: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/backend-api/wham/usage")) {
      const headers = init?.headers as Record<string, string>;
      if (headers.Authorization === "Bearer old-access") {
        return Response.json({ error: { message: "expired" } }, { status: 401 });
      }
      expect(headers.Authorization).toBe("Bearer new-access");
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          secondary_window: { used_percent: 2, limit_window_seconds: 18000, reset_after_seconds: 3600 },
        },
      });
    }
    expect(url).toBe("https://auth.openai.com/oauth/token");
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });
  };
  const manager = new CodexAccountManager({
    storagePath: tempFile(),
    fetchImpl: fakeFetch as typeof fetch,
    now: () => 100_000,
  });
  await manager.init();
  await manager.upsertCredentials({
    email: "retry@example.com",
    accountId: "acct_retry",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 10_000_000,
  });

  const [snapshot] = await manager.getUsageSnapshots();

  expect(calls).toEqual([
    "https://chatgpt.com/backend-api/wham/usage",
    "https://auth.openai.com/oauth/token",
    "https://chatgpt.com/backend-api/wham/usage",
  ]);
  expect(snapshot.error).toBeNull();
  expect(snapshot.usage?.secondaryWindow?.usedPercent).toBe(2);
});


test("skips accounts whose cached WHAM quota is exhausted and restores them after reset", async () => {
  let now = 1_700_000_000_000;
  let blocked = true;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://chatgpt.com/backend-api/wham/usage");
    const headers = init?.headers as Record<string, string>;
    if (headers["ChatGPT-Account-Id"] === "acct_b") {
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          allowed: !blocked,
          limit_reached: blocked,
          secondary_window: {
            used_percent: blocked ? 100 : 0,
            limit_window_seconds: 18000,
            reset_at: Math.floor((now + 60_000) / 1000),
          },
        },
      });
    }
    return Response.json({
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        secondary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor((now + 60_000) / 1000) },
      },
    });
  };
  const manager = new CodexAccountManager({ storagePath: tempFile(), fetchImpl: fakeFetch as typeof fetch, now: () => now });
  await manager.init();
  await manager.upsertCredentials({ email: "a@example.com", accountId: "acct_a", accessToken: "a", refreshToken: "ra", expiresAt: now + 3600_000 });
  await manager.upsertCredentials({ email: "b@example.com", accountId: "acct_b", accessToken: "b", refreshToken: "rb", expiresAt: now + 3600_000 });

  await manager.getUsageSnapshots();
  expect((await manager.selectAccount({ preferredEmail: "b@example.com" }))?.email).toBe("a@example.com");
  expect(manager.listPublic().find(account => account.email === "b@example.com")?.available).toBe(false);

  now += 61_000;
  expect((await manager.selectAccount({ preferredEmail: "b@example.com" }))?.email).toBe("b@example.com");

  blocked = false;
  await manager.getUsageSnapshots();
  expect(manager.listPublic().find(account => account.email === "b@example.com")?.available).toBe(true);
});
