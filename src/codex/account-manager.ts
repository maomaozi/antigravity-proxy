import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexCredentials } from "./device-auth";
import { CODEX_AUTH_ISSUER, CODEX_AUTH_SCOPE, CODEX_CLIENT_ID } from "./device-auth";

export interface CodexAccount extends CodexCredentials {
  lastUsed: number;
  cooldownUntil: number;
}

export interface CodexPublicAccount {
  email: string;
  accountId: string;
  expiresAt: number;
  lastUsed: number;
  cooldownUntil: number;
  available: boolean;
}

interface StoredCodexAccounts {
  accounts: CodexAccount[];
}

export class CodexAccountManager {
  private accounts: CodexAccount[] = [];
  private readonly storagePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly refreshLeadMs: number;

  constructor(options: {
    storagePath?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    issuer?: string;
    clientId?: string;
    refreshLeadMs?: number;
  } = {}) {
    this.storagePath = options.storagePath || "data/codex-accounts.json";
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || Date.now;
    this.issuer = (options.issuer || CODEX_AUTH_ISSUER).replace(/\/+$/, "");
    this.clientId = options.clientId || CODEX_CLIENT_ID;
    this.refreshLeadMs = options.refreshLeadMs ?? 5 * 60_000;
  }

  async init(): Promise<void> {
    if (this.storagePath === ":memory:") {
      this.accounts = [];
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(this.storagePath, "utf8")) as StoredCodexAccounts;
      this.accounts = Array.isArray(parsed?.accounts) ? parsed.accounts.map(account => ({
        ...account,
        lastUsed: Number(account.lastUsed) || 0,
        cooldownUntil: Number(account.cooldownUntil) || 0,
      })) : [];
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.accounts = [];
    }
  }

  listPublic(): CodexPublicAccount[] {
    const now = this.now();
    return this.accounts.map(account => ({
      email: account.email,
      accountId: account.accountId,
      expiresAt: account.expiresAt,
      lastUsed: account.lastUsed,
      cooldownUntil: account.cooldownUntil,
      available: account.cooldownUntil <= now,
    }));
  }

  async upsertCredentials(credentials: CodexCredentials): Promise<CodexAccount> {
    const index = this.accounts.findIndex(account => account.email === credentials.email);
    const previous = index >= 0 ? this.accounts[index] : undefined;
    const account: CodexAccount = {
      ...credentials,
      lastUsed: previous?.lastUsed || 0,
      cooldownUntil: previous?.cooldownUntil || 0,
    };
    if (index >= 0) this.accounts[index] = account;
    else this.accounts.push(account);
    await this.persist();
    return account;
  }

  async remove(email: string): Promise<boolean> {
    const index = this.accounts.findIndex(account => account.email === email);
    if (index < 0) return false;
    this.accounts.splice(index, 1);
    await this.persist();
    return true;
  }

  async selectAccount(options: { preferredEmail?: string | null; excludeEmails?: Iterable<string> } = {}): Promise<CodexAccount | null> {
    const excluded = new Set(options.excludeEmails || []);
    const now = this.now();
    const candidates = this.accounts.filter(account => !excluded.has(account.email) && account.cooldownUntil <= now);
    if (!candidates.length) return null;

    const preferred = options.preferredEmail ? candidates.find(account => account.email === options.preferredEmail) : undefined;
    const ordered = preferred ? [preferred, ...candidates.filter(account => account !== preferred)] : [...candidates].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const account of ordered) {
      const ready = await this.ensureReady(account);
      if (ready) {
        ready.lastUsed = now;
        await this.persist();
        return ready;
      }
    }
    return null;
  }

  async refreshAccount(email: string): Promise<boolean> {
    const account = this.accounts.find(item => item.email === email);
    if (!account) return false;
    try {
      const response = await this.fetchImpl(`${this.issuer}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
          scope: CODEX_AUTH_SCOPE,
        }).toString(),
      });
      if (!response.ok) return false;
      const tokens: any = await response.json();
      if (!tokens.access_token) return false;
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      if (tokens.id_token) account.idToken = tokens.id_token;
      account.expiresAt = this.now() + (Number(tokens.expires_in) || 3600) * 1000;
      account.cooldownUntil = 0;
      await this.persist();
      return true;
    } catch {
      return false;
    }
  }

  async markCooldown(email: string, durationMs: number): Promise<void> {
    const account = this.accounts.find(item => item.email === email);
    if (!account) return;
    const duration = Number.isFinite(durationMs) ? Math.max(0, Math.trunc(durationMs)) : 60_000;
    account.cooldownUntil = Math.max(account.cooldownUntil, this.now() + duration);
    await this.persist();
  }

  async clearCooldown(email: string): Promise<void> {
    const account = this.accounts.find(item => item.email === email);
    if (!account) return;
    account.cooldownUntil = 0;
    await this.persist();
  }

  private async ensureReady(account: CodexAccount): Promise<CodexAccount | null> {
    if (!account.accessToken || account.expiresAt <= this.now() + this.refreshLeadMs) {
      if (!await this.refreshAccount(account.email)) return null;
    }
    return this.accounts.find(item => item.email === account.email) || null;
  }

  private async persist(): Promise<void> {
    if (this.storagePath === ":memory:") return;
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temp = `${this.storagePath}.tmp`;
    await writeFile(temp, JSON.stringify({ accounts: this.accounts }, null, 2), { mode: 0o600 });
    await rename(temp, this.storagePath);
  }
}
