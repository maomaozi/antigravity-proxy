import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAccounts, getBestAccount, getFamilyName } from "../../src/auth/manager";
import type { AntigravityAccount } from "../../src/auth/types";

const originalAccounts: AntigravityAccount[] = [];

function testAccount(name: string): AntigravityAccount {
  return {
    email: `${name}@example.com`,
    refreshToken: `refresh-${name}`,
    accessToken: `access-${name}`,
    expiresAt: Date.now() + 3600_000,
    projectId: `project-${name}`,
    healthScore: 100,
    lastUsed: 0,
    tokenUsage: 0,
  };
}

beforeEach(() => {
  const accounts = getAccounts();
  originalAccounts.splice(0, originalAccounts.length, ...accounts.map(account => ({ ...account })));
  accounts.splice(0, accounts.length,
    testAccount("a"),
    testAccount("b"),
    testAccount("c"),
    testAccount("d"),
  );
});

afterEach(() => {
  const accounts = getAccounts();
  accounts.splice(0, accounts.length, ...originalAccounts.map(account => ({ ...account })));
});

describe("Manager Utils", () => {
  test("getFamilyName should correctly classify models", () => {
    expect(getFamilyName("gemini-3.7-flash-tiered")).toBe("Gemini Models");
    expect(getFamilyName("gemini-3.6-flash-medium")).toBe("Gemini Models");
    expect(getFamilyName("gemini-3.5-flash-low")).toBe("Gemini Models");
    expect(getFamilyName("gemini-3.1-pro-high")).toBe("Gemini Models");
    expect(getFamilyName("claude-sonnet-4-6-thinking")).toBe("Claude Sonnet 4.6");
    expect(getFamilyName("claude-opus-4-6-thinking")).toBe("Claude Opus 4.6");
    expect(getFamilyName("gpt-oss-120b-medium")).toBe("GPT-OSS 120B");
    expect(getFamilyName("unknown-model")).toBe("Other");
  });

  test("keeps Gemini rendezvous routing stable for the same Codex thread", async () => {
    const picks = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const account = await getBestAccount(
        "sandbox",
        "antigravity-gemini-3.8-flash",
        undefined,
        [],
        true,
        "codex-thread:stable-thread",
      );
      expect(account).not.toBeNull();
      picks.add(account!.email);
    }
    expect(picks.size).toBe(1);
  });

  test("spreads Codex Gemini threads evenly across four Google accounts", async () => {
    const counts = new Map<string, number>(getAccounts().map(account => [account.email, 0]));

    for (let index = 0; index < 1000; index++) {
      const account = await getBestAccount(
        "sandbox",
        "antigravity-gemini-3.8-flash",
        undefined,
        [],
        true,
        `codex-thread:distribution-${index}`,
      );
      expect(account).not.toBeNull();
      counts.set(account!.email, (counts.get(account!.email) || 0) + 1);
    }

    expect(counts.size).toBe(4);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(200);
      expect(count).toBeLessThanOrEqual(300);
    }
  });

  test("uses the next deterministic Gemini HRW candidate when the preferred account is excluded", async () => {
    const routingKey = "codex-thread:failover";
    const first = await getBestAccount(
      "sandbox",
      "antigravity-gemini-3.8-flash",
      undefined,
      [],
      true,
      routingKey,
    );
    expect(first).not.toBeNull();

    const second = await getBestAccount(
      "sandbox",
      "antigravity-gemini-3.8-flash",
      undefined,
      [first!.email],
      true,
      routingKey,
    );
    const repeated = await getBestAccount(
      "sandbox",
      "antigravity-gemini-3.8-flash",
      undefined,
      [first!.email],
      true,
      routingKey,
    );

    expect(second).not.toBeNull();
    expect(second!.email).not.toBe(first!.email);
    expect(repeated!.email).toBe(second!.email);
  });
});
