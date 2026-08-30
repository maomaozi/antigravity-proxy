import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexCredentials } from "./device-auth";
import { CODEX_AUTH_ISSUER, CODEX_AUTH_SCOPE, CODEX_CLIENT_ID } from "./device-auth";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_TIMEOUT_MS = 30_000;

export interface CodexAccount extends CodexCredentials {
  lastUsed: number;
  cooldownUntil: number;
}


export interface CodexUsageWindow {
  usedPercent: number | null;
  limitWindowSeconds: number | null;
  resetAt: number | null;
  resetAfterSeconds: number | null;
}

export interface CodexUsageCredits {
  balance: string | number | null;
  hasCredits: boolean | null;
  unlimited: boolean | null;
}

export interface CodexUsage {
  planType: string | null;
  allowed: boolean | null;
  limitReached: boolean | null;
  primaryWindow: CodexUsageWindow | null;
  secondaryWindow: CodexUsageWindow | null;
  credits: CodexUsageCredits | null;
}

export interface CodexUsageSnapshot {
  email: string;
  accountId: string;
  usage: CodexUsage | null;
  error: { status: number | null; message: string } | null;
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function epochMsOrNull(value: unknown): number | null {
  const number = finiteNumberOrNull(value);
  if (number === null || number <= 0) return null;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function normalizeUsageWindow(value: unknown): CodexUsageWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const window = value as Record<string, unknown>;
  return {
    usedPercent: finiteNumberOrNull(window.used_percent),
    limitWindowSeconds: finiteNumberOrNull(window.limit_window_seconds),
    resetAt: epochMsOrNull(window.reset_at),
    resetAfterSeconds: finiteNumberOrNull(window.reset_after_seconds),
  };
}

function normalizeUsage(body: unknown): CodexUsage {
  const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, any> : {};
  const rateLimit = payload.rate_limit && typeof payload.rate_limit === "object" && !Array.isArray(payload.rate_limit)
    ? payload.rate_limit as Record<string, any>
    : {};
  const credits = payload.credits && typeof payload.credits === "object" && !Array.isArray(payload.credits)
    ? payload.credits as Record<string, any>
    : null;
  return {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : null,
    allowed: typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : null,
    limitReached: typeof rateLimit.limit_reached === "boolean" ? rateLimit.limit_reached : null,
    primaryWindow: normalizeUsageWindow(rateLimit.primary_window),
    secondaryWindow: normalizeUsageWindow(rateLimit.secondary_window),
    credits: credits ? {
      balance: typeof credits.balance === "string" || typeof credits.balance === "number" ? credits.balance : null,
      hasCredits: typeof credits.has_credits === "boolean" ? credits.has_credits : null,
      unlimited: typeof credits.unlimited === "boolean" ? credits.unlimited : null,
    } : null,
  };
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

interface CodexQuotaState {
  blocked: boolean;
  blockedUntil: number | null;
  fetchedAt: number;
}

export class CodexAccountManager {
  private accounts: CodexAccount[] = [];
  private readonly storagePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly refreshLeadMs: number;
  private readonly quotaState = new Map<string, CodexQuotaState>();

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
      available: account.cooldownUntil <= now && !this.isQuotaBlocked(account.email, now),
    }));
  }

  async upsertCredentials(credentials: CodexCredentials): Promise<CodexAccount> {
    const index = this.accounts.findIndex(account => account.email === credentials.email);
    const previous = index >= 0 ? this.accounts[index] : undefined;
    if (previous && previous.accountId !== credentials.accountId) this.quotaState.delete(credentials.email);
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

  async getUsageSnapshots(): Promise<CodexUsageSnapshot[]> {
    return Promise.all(this.accounts.map(account => this.fetchUsageSnapshot(account, true)));
  }

  private async fetchUsageSnapshot(account: CodexAccount, allowRefresh: boolean): Promise<CodexUsageSnapshot> {
    const snapshot: CodexUsageSnapshot = {
      email: account.email,
      accountId: account.accountId,
      usage: null,
      error: null,
    };

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${account.accessToken}`,
        Accept: "application/json",
        "User-Agent": "codex-cli",
      };
      if (account.accountId) headers["ChatGPT-Account-Id"] = account.accountId;

      const response = await this.fetchImpl(CODEX_USAGE_URL, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(CODEX_USAGE_TIMEOUT_MS),
      });
      const text = await response.text();
      let body: any = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      if (response.status === 401 && allowRefresh && await this.refreshAccount(account.email)) {
        const refreshed = this.accounts.find(item => item.email === account.email);
        if (refreshed) return this.fetchUsageSnapshot(refreshed, false);
      }

      if (!response.ok) {
        const upstreamMessage = body?.error?.message || body?.detail || body?.message ||
          (typeof body === "string" ? body : "") || response.statusText;
        snapshot.error = {
          status: response.status,
          message: `Codex usage request failed (${response.status}): ${String(upstreamMessage).slice(0, 500)}`,
        };
        return snapshot;
      }

      snapshot.usage = normalizeUsage(body);
      this.updateQuotaState(account.email, snapshot.usage);
      return snapshot;
    } catch (error: any) {
      snapshot.error = {
        status: null,
        message: error?.message || String(error),
      };
      return snapshot;
    }
  }

  async remove(email: string): Promise<boolean> {
    const index = this.accounts.findIndex(account => account.email === email);
    if (index < 0) return false;
    this.accounts.splice(index, 1);
    this.quotaState.delete(email);
    await this.persist();
    return true;
  }

  async selectAccount(options: { preferredEmail?: string | null; excludeEmails?: Iterable<string> } = {}): Promise<CodexAccount | null> {
    const excluded = new Set(options.excludeEmails || []);
    const now = this.now();
    const candidates = this.accounts.filter(account => !excluded.has(account.email) && account.cooldownUntil <= now && !this.isQuotaBlocked(account.email, now));
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

  async prepareAccountForRequest(email: string, forceRefresh = false): Promise<CodexAccount | null> {
    const account = this.accounts.find(item => item.email === email);
    if (!account) return null;
    if (forceRefresh && !await this.refreshAccount(email)) return null;
    return this.ensureReady(this.accounts.find(item => item.email === email) || account);
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

  private updateQuotaState(email: string, usage: CodexUsage): void {
    const now = this.now();
    const windows = [usage.primaryWindow, usage.secondaryWindow].filter((window): window is CodexUsageWindow => !!window);
    const saturated = windows.filter(window => window.usedPercent !== null && window.usedPercent >= 100);
    const blocked = usage.limitReached === true || usage.allowed === false || saturated.length > 0;
    const resetSource = saturated.length > 0 ? saturated : windows;
    const resetCandidates = resetSource.map(window => {
      if (window.resetAt !== null && window.resetAt > now) return window.resetAt;
      if (window.resetAfterSeconds !== null && window.resetAfterSeconds > 0) return now + window.resetAfterSeconds * 1000;
      return null;
    }).filter((value): value is number => value !== null);
    this.quotaState.set(email, {
      blocked,
      blockedUntil: blocked && resetCandidates.length > 0 ? Math.max(...resetCandidates) : null,
      fetchedAt: now,
    });
  }

  private isQuotaBlocked(email: string, now = this.now()): boolean {
    const state = this.quotaState.get(email);
    if (!state?.blocked) return false;
    if (state.blockedUntil !== null && state.blockedUntil <= now) return false;
    return true;
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
