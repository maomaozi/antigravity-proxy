import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAccountStorage } from "../../src/auth/storage";
import type { AntigravityAccount } from "../../src/auth/types";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "google-storage-"));
  dirs.push(dir);
  const path = join(dir, "accounts.json");
  return { path, storage: new GoogleAccountStorage(path) };
}
function account(): AntigravityAccount {
  return { email: "one@example.com", refreshToken: "secret-refresh", accessToken: "secret-access", healthScore: 75, lastUsed: 123, tokenUsage: 50, cooldowns: { "sandbox|Gemini Models": 999 }, quota: [], quotaWindows: [{ groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.6 }] };
}

describe("Google account storage", () => {
  test("migrates legacy arrays and separates credentials from runtime state", async () => {
    const { path, storage } = await fixture();
    await writeFile(path, JSON.stringify([account()]));
    expect((await storage.load()).accounts).toEqual([account()]);
    const credentials = JSON.parse(await readFile(path, "utf8"));
    expect(credentials.accounts[0].refreshToken).toBe("secret-refresh");
    expect(credentials.accounts[0]).not.toHaveProperty("healthScore");
    expect(credentials.accounts[0]).not.toHaveProperty("quota");
    const runtime = await readFile(`${path}.state.json`, "utf8");
    expect(runtime).not.toContain("secret-refresh");
    expect(runtime).not.toContain("secret-access");
    expect((await stat(`${path}.bak`)).size).toBeGreaterThan(0);
    expect((await new GoogleAccountStorage(path).load()).accounts).toEqual([account()]);
  });

  test("ordinary usage updates leave the credential file and its backups untouched", async () => {
    const { path, storage } = await fixture();
    const saved = account();
    await storage.save({ accounts: [saved] });
    const before = await stat(path);
    const backupBefore = await stat(`${path}.bak`);
    saved.healthScore = 95;
    saved.lastUsed = 789;
    saved.quota = [{ groupName: "Gemini", limit: "", usage: "", limitName: "gemini", remainingFraction: 0.5, quotaLeft: "50%", resetIn: "1h" }];
    await storage.save({ accounts: [saved] });
    expect((await stat(path)).ino).toBe(before.ino);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect((await stat(`${path}.bak`)).ino).toBe(backupBefore.ino);
    expect((await new GoogleAccountStorage(path).load()).accounts[0]).toEqual(saved);
  });

  test("concurrent credential changes and account deletion cannot resurrect an account", async () => {
    const { path, storage } = await fixture();
    const saved = account();
    const first = storage.save({ accounts: [saved] });
    saved.refreshToken = "new-refresh";
    const second = storage.save({ accounts: [saved] });
    const third = storage.save({ accounts: [] });
    await Promise.all([first, second, third]);
    expect((await new GoogleAccountStorage(path).load()).accounts).toEqual([]);
  });

  test("recovers credentials after zero-fill damage without trusting runtime credentials", async () => {
    const { path, storage } = await fixture();
    await storage.save({ accounts: [account()] });
    await writeFile(path, Buffer.alloc(100));
    await writeFile(`${path}.state.json`, JSON.stringify({ accounts: [{ email: "one@example.com", refreshToken: "injected", accessToken: "injected", healthScore: 25 }] }));
    const loaded = await new GoogleAccountStorage(path).load();
    expect(loaded.accounts[0]?.refreshToken).toBe("secret-refresh");
    expect(loaded.accounts[0]?.accessToken).toBe("secret-access");
    expect(loaded.accounts[0]?.healthScore).toBe(25);
  });

  test("resets unrecoverable metrics while keeping credentials usable and allowing future saves", async () => {
    const { path, storage } = await fixture();
    await storage.save({ accounts: [account()] });
    await writeFile(`${path}.state.json`, "broken");
    await writeFile(`${path}.state.json.bak`, "broken");
    const reloaded = new GoogleAccountStorage(path);
    const loaded = await reloaded.load();
    expect(loaded.accounts[0]?.refreshToken).toBe("secret-refresh");
    expect(loaded.accounts[0]?.healthScore).toBe(100);
    loaded.accounts[0]!.healthScore = 90;
    await reloaded.save(loaded);
    expect((await reloaded.load()).accounts[0]?.healthScore).toBe(90);
  });

  test("unrecoverable credentials fail startup instead of returning an empty list", async () => {
    const { path, storage } = await fixture();
    await writeFile(path, Buffer.alloc(100));
    await expect(storage.load()).rejects.toThrow("refusing to overwrite");
    expect(await readFile(path)).toEqual(Buffer.alloc(100));
  });
});
