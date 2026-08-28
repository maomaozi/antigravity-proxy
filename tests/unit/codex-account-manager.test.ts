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
