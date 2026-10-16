import { join } from "node:path";
import { readDurableJson, writeDurableJson } from "../utils/durable-json";
import { type AntigravityAccount } from "./types";

interface StorageFormat {
    accounts: AntigravityAccount[];
}

const runtimeKeys = ["healthScore", "modelScores", "lastUsed", "tokenUsage", "consecutiveFailures", "cooldowns", "history", "challenge", "capabilities", "quota"] as const;
type RuntimeAccount = Pick<AntigravityAccount, "email"> & Partial<Pick<AntigravityAccount, typeof runtimeKeys[number]>>;

function decodeAccounts(value: unknown): StorageFormat {
  const accounts = Array.isArray(value) ? value : (value as StorageFormat | null)?.accounts;
  if (!Array.isArray(accounts) || !accounts.every(account => account && typeof account.email === "string" && typeof account.refreshToken === "string" && account.refreshToken)) {
    throw new Error("Invalid Google account storage");
  }
  return { accounts };
}

function decodeState(value: unknown): { accounts: RuntimeAccount[] } {
  const accounts = (value as { accounts?: RuntimeAccount[] } | null)?.accounts;
  if (!Array.isArray(accounts) || !accounts.every(account => account && typeof account.email === "string")) throw new Error("Invalid Google runtime state");
  return { accounts };
}

export class GoogleAccountStorage {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<StorageFormat> {
    const stored = await readDurableJson(this.path, decodeAccounts);
    if (!stored) return { accounts: [] };
    let states: RuntimeAccount[] = [];
    try {
      states = (await readDurableJson(`${this.path}.state.json`, decodeState))?.accounts || [];
    } catch (error) {
      console.warn("[Storage] Google runtime state unavailable; keeping credentials and resetting metrics:", error);
    }
    const result = { accounts: stored.accounts.map(account => {
      const state = states.find(candidate => candidate.email === account.email);
      const merged = { ...account, healthScore: account.healthScore ?? 100, lastUsed: account.lastUsed ?? 0, tokenUsage: account.tokenUsage ?? 0 };
      if (state) for (const key of runtimeKeys) if (Object.hasOwn(state, key)) (merged as any)[key] = state[key];
      return merged;
    }) };
    // Migrate legacy combined files and establish backups before serving requests.
    await this.save(result);
    return result;
  }

  save(config: StorageFormat): Promise<void> {
    const snapshot = decodeAccounts(JSON.parse(JSON.stringify(config)));
    const credentials = { accounts: snapshot.accounts.map(account => {
      const credential = { ...account };
      for (const key of runtimeKeys) delete (credential as any)[key];
      return credential;
    }) };
    const states = { accounts: snapshot.accounts.map(account => {
      const state: RuntimeAccount = { email: account.email };
      for (const key of runtimeKeys) if (Object.hasOwn(account, key)) (state as any)[key] = account[key];
      return state;
    }) };
    const next = this.queue.catch(() => {}).then(async () => {
      await writeDurableJson(this.path, credentials, decodeAccounts);
      await writeDurableJson(`${this.path}.state.json`, states, decodeState, { resetCorrupt: true });
    });
    this.queue = next;
    return next;
  }
}

const storage = new GoogleAccountStorage(process.env.ACCOUNTS_FILE || join(process.cwd(), "antigravity-accounts.json"));

export function loadConfig(): Promise<StorageFormat> {
  return storage.load();
}

export function saveConfig(config: StorageFormat): Promise<void> {
  return storage.save(config);
}
