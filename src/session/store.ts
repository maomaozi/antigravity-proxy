import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionIdentity } from "./identity";

export type SessionPool = "cli" | "sandbox";

export interface SessionBinding {
  id: number;
  sessionKey: string;
  sessionId: string;
  source: string;
  inferred: boolean;
  accountEmail: string;
  model: string;
  modelFamily: string;
  pool: SessionPool;
  projectId: string | null;
  endpoint: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  requestCount: number;
}

export interface RecordBindingInput {
  identity: SessionIdentity;
  accountEmail: string;
  model: string;
  modelFamily: string;
  pool: SessionPool;
  projectId?: string;
  endpoint?: string;
}

export interface RequestTokenUsage {
  id: number;
  requestId: string;
  sessionKey: string;
  sessionId: string;
  sessionSource: string;
  sessionInferred: boolean;
  accountEmail: string;
  model: string;
  modelFamily: string;
  upstreamModel: string | null;
  pool: SessionPool;
  endpoint: string | null;
  streamed: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningTokensReported: boolean;
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecordRequestTokenUsageInput {
  requestId: string;
  identity: SessionIdentity;
  accountEmail: string;
  model: string;
  modelFamily: string;
  upstreamModel?: string;
  pool: SessionPool;
  endpoint?: string;
  streamed: boolean;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  reasoningTokensReported?: boolean;
  totalTokens: number;
  createdAt?: number;
}

export interface RequestTokenUsageListOptions {
  limit?: number;
  offset?: number;
  search?: string;
  model?: string;
  sessionKey?: string;
  from?: number;
  to?: number;
}

export interface RequestTokenUsageSummary {
  requests: number;
  sessions: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

interface BindingRow {
  id: number;
  session_key: string;
  session_id: string;
  source: string;
  inferred: number;
  account_email: string;
  model: string;
  model_family: string;
  pool: SessionPool;
  project_id: string | null;
  endpoint: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
  request_count: number;
}

interface RequestTokenUsageRow {
  id: number;
  request_id: string;
  session_key: string;
  session_id: string;
  session_source: string;
  session_inferred: number;
  account_email: string;
  model: string;
  model_family: string;
  upstream_model: string | null;
  pool: SessionPool;
  endpoint: string | null;
  streamed: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  reasoning_tokens_reported: number;
  total_tokens: number;
  created_at: number;
  updated_at: number;
}

function mapRow(row: BindingRow): SessionBinding {
  return {
    id: row.id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    source: row.source,
    inferred: row.inferred === 1,
    accountEmail: row.account_email,
    model: row.model,
    modelFamily: row.model_family,
    pool: row.pool,
    projectId: row.project_id,
    endpoint: row.endpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    requestCount: row.request_count,
  };
}

function mapUsageRow(row: RequestTokenUsageRow): RequestTokenUsage {
  return {
    id: row.id,
    requestId: row.request_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    sessionSource: row.session_source,
    sessionInferred: row.session_inferred === 1,
    accountEmail: row.account_email,
    model: row.model,
    modelFamily: row.model_family,
    upstreamModel: row.upstream_model,
    pool: row.pool,
    endpoint: row.endpoint,
    streamed: row.streamed === 1,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    uncachedInputTokens: Math.max(0, row.input_tokens - row.cached_input_tokens),
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    reasoningTokensReported: row.reasoning_tokens_reported === 1,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tokenCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : 0;
}

export class SessionBindingStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        inferred INTEGER NOT NULL DEFAULT 0,
        account_email TEXT NOT NULL,
        model TEXT NOT NULL,
        model_family TEXT NOT NULL,
        pool TEXT NOT NULL CHECK (pool IN ('cli', 'sandbox')),
        project_id TEXT,
        endpoint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        UNIQUE(session_key, model)
      );
      CREATE INDEX IF NOT EXISTS idx_session_bindings_updated_at
        ON session_bindings(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_bindings_account
        ON session_bindings(account_email);

      CREATE TABLE IF NOT EXISTS request_token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_source TEXT NOT NULL,
        session_inferred INTEGER NOT NULL DEFAULT 0,
        account_email TEXT NOT NULL,
        model TEXT NOT NULL,
        model_family TEXT NOT NULL,
        upstream_model TEXT,
        pool TEXT NOT NULL CHECK (pool IN ('cli', 'sandbox')),
        endpoint TEXT,
        streamed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens_reported INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_session
        ON request_token_usage(session_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_created_at
        ON request_token_usage(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_model
        ON request_token_usage(model, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_account
        ON request_token_usage(account_email, created_at DESC);
    `);
  }

  get(sessionKey: string, model: string): SessionBinding | null {
    const row = this.db.query<BindingRow, [string, string]>(`
      SELECT * FROM session_bindings
      WHERE session_key = ? AND model = ?
      LIMIT 1
    `).get(sessionKey, model.toLowerCase());
    return row ? mapRow(row) : null;
  }

  record(input: RecordBindingInput): SessionBinding {
    const now = Date.now();
    const model = input.model.toLowerCase();
    this.db.query(`
      INSERT INTO session_bindings (
        session_key, session_id, source, inferred, account_email, model,
        model_family, pool, project_id, endpoint, created_at, updated_at,
        last_used_at, request_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(session_key, model) DO UPDATE SET
        session_id = excluded.session_id,
        source = excluded.source,
        inferred = excluded.inferred,
        account_email = excluded.account_email,
        model_family = excluded.model_family,
        pool = excluded.pool,
        project_id = excluded.project_id,
        endpoint = excluded.endpoint,
        updated_at = excluded.updated_at,
        last_used_at = excluded.last_used_at,
        request_count = session_bindings.request_count + 1
    `).run(
      input.identity.key,
      input.identity.id,
      input.identity.source,
      input.identity.inferred ? 1 : 0,
      input.accountEmail,
      model,
      input.modelFamily,
      input.pool,
      input.projectId ?? null,
      input.endpoint ?? null,
      now,
      now,
      now,
    );
    return this.get(input.identity.key, model)!;
  }

  list(options: { limit?: number; offset?: number; search?: string } = {}): { bindings: SessionBinding[]; total: number } {
    const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 200;
    const requestedOffset = Number.isFinite(options.offset) ? Math.trunc(options.offset!) : 0;
    const limit = Math.max(1, Math.min(requestedLimit, 1000));
    const offset = Math.max(0, requestedOffset);
    const search = options.search?.trim();
    const where = search
      ? "WHERE session_id LIKE ? OR account_email LIKE ? OR model LIKE ? OR model_family LIKE ? OR source LIKE ?"
      : "";
    const args = search ? Array(5).fill(`%${search}%`) : [];
    const rows = this.db.query<BindingRow, any[]>(`
      SELECT * FROM session_bindings ${where}
      ORDER BY last_used_at DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);
    const countRow = this.db.query<{ count: number }, any[]>(`
      SELECT COUNT(*) AS count FROM session_bindings ${where}
    `).get(...args);
    return { bindings: rows.map(mapRow), total: countRow?.count ?? 0 };
  }

  recordRequestTokenUsage(input: RecordRequestTokenUsageInput): RequestTokenUsage {
    const now = Date.now();
    const createdAt = Number.isFinite(input.createdAt) ? Math.trunc(input.createdAt!) : now;
    const model = input.model.toLowerCase();
    this.db.query(`
      INSERT INTO request_token_usage (
        request_id, session_key, session_id, session_source, session_inferred,
        account_email, model, model_family, upstream_model, pool, endpoint,
        streamed, input_tokens, cached_input_tokens, output_tokens,
        reasoning_tokens, reasoning_tokens_reported, total_tokens, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        session_key = excluded.session_key,
        session_id = excluded.session_id,
        session_source = excluded.session_source,
        session_inferred = excluded.session_inferred,
        account_email = excluded.account_email,
        model = excluded.model,
        model_family = excluded.model_family,
        upstream_model = excluded.upstream_model,
        pool = excluded.pool,
        endpoint = excluded.endpoint,
        streamed = excluded.streamed,
        input_tokens = MAX(request_token_usage.input_tokens, excluded.input_tokens),
        cached_input_tokens = MAX(request_token_usage.cached_input_tokens, excluded.cached_input_tokens),
        output_tokens = MAX(request_token_usage.output_tokens, excluded.output_tokens),
        reasoning_tokens = MAX(request_token_usage.reasoning_tokens, excluded.reasoning_tokens),
        reasoning_tokens_reported = MAX(request_token_usage.reasoning_tokens_reported, excluded.reasoning_tokens_reported),
        total_tokens = MAX(request_token_usage.total_tokens, excluded.total_tokens),
        updated_at = excluded.updated_at
    `).run(
      input.requestId,
      input.identity.key,
      input.identity.id,
      input.identity.source,
      input.identity.inferred ? 1 : 0,
      input.accountEmail,
      model,
      input.modelFamily,
      input.upstreamModel ?? null,
      input.pool,
      input.endpoint ?? null,
      input.streamed ? 1 : 0,
      tokenCount(input.inputTokens),
      tokenCount(input.cachedInputTokens),
      tokenCount(input.outputTokens),
      tokenCount(input.reasoningTokens),
      input.reasoningTokensReported ? 1 : 0,
      tokenCount(input.totalTokens),
      createdAt,
      now,
    );

    const row = this.db.query<RequestTokenUsageRow, [string]>(`
      SELECT * FROM request_token_usage WHERE request_id = ? LIMIT 1
    `).get(input.requestId);
    if (!row) throw new Error("Failed to persist request token usage");
    return mapUsageRow(row);
  }

  listRequestTokenUsage(options: RequestTokenUsageListOptions = {}): {
    records: RequestTokenUsage[];
    total: number;
    summary: RequestTokenUsageSummary;
  } {
    const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 200;
    const requestedOffset = Number.isFinite(options.offset) ? Math.trunc(options.offset!) : 0;
    const limit = Math.max(1, Math.min(requestedLimit, 1000));
    const offset = Math.max(0, requestedOffset);
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    const search = options.search?.trim();

    if (search) {
      clauses.push("(request_id LIKE ? OR session_id LIKE ? OR account_email LIKE ? OR model LIKE ? OR model_family LIKE ? OR session_source LIKE ?)");
      args.push(...Array(6).fill(`%${search}%`));
    }
    if (options.model?.trim()) {
      clauses.push("model = ?");
      args.push(options.model.trim().toLowerCase());
    }
    if (options.sessionKey?.trim()) {
      clauses.push("session_key = ?");
      args.push(options.sessionKey.trim());
    }
    if (Number.isFinite(options.from)) {
      clauses.push("created_at >= ?");
      args.push(Math.trunc(options.from!));
    }
    if (Number.isFinite(options.to)) {
      clauses.push("created_at <= ?");
      args.push(Math.trunc(options.to!));
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.query<RequestTokenUsageRow, any[]>(`
      SELECT * FROM request_token_usage ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);
    const aggregate = this.db.query<{
      requests: number;
      sessions: number;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      total_tokens: number;
    }, any[]>(`
      SELECT
        COUNT(*) AS requests,
        COUNT(DISTINCT session_key) AS sessions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM request_token_usage ${where}
    `).get(...args);
    const inputTokens = aggregate?.input_tokens ?? 0;
    const cachedInputTokens = aggregate?.cached_input_tokens ?? 0;

    return {
      records: rows.map(mapUsageRow),
      total: aggregate?.requests ?? 0,
      summary: {
        requests: aggregate?.requests ?? 0,
        sessions: aggregate?.sessions ?? 0,
        inputTokens,
        cachedInputTokens,
        uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
        outputTokens: aggregate?.output_tokens ?? 0,
        reasoningTokens: aggregate?.reasoning_tokens ?? 0,
        totalTokens: aggregate?.total_tokens ?? 0,
      },
    };
  }

  delete(id: number): boolean {
    return this.db.query("DELETE FROM session_bindings WHERE id = ?").run(id).changes > 0;
  }

  deleteForAccount(email: string): number {
    return this.db.query("DELETE FROM session_bindings WHERE account_email = ?").run(email).changes;
  }

  clear(): number {
    return this.db.query("DELETE FROM session_bindings").run().changes;
  }

  clearRequestTokenUsage(): number {
    return this.db.query("DELETE FROM request_token_usage").run().changes;
  }

  pruneOlderThan(timestamp: number): number {
    return this.db.query("DELETE FROM session_bindings WHERE updated_at < ?").run(timestamp).changes;
  }

  pruneRequestTokenUsageOlderThan(timestamp: number): number {
    return this.db.query("DELETE FROM request_token_usage WHERE created_at < ?").run(timestamp).changes;
  }

  close(): void {
    this.db.close();
  }
}

let defaultStore: SessionBindingStore | undefined;

export function initSessionBindingStore(): SessionBindingStore {
  if (!defaultStore) {
    const path = process.env.SESSION_DB_FILE || join(process.cwd(), "data", "session-bindings.sqlite");
    defaultStore = new SessionBindingStore(path);
    const configuredRetention = Number(process.env.SESSION_BINDING_RETENTION_DAYS || 30);
    const retentionDays = Number.isFinite(configuredRetention) ? Math.max(1, configuredRetention) : 30;
    const removed = defaultStore.pruneOlderThan(Date.now() - retentionDays * 86400000);
    const configuredUsageRetention = Number(process.env.REQUEST_USAGE_RETENTION_DAYS || retentionDays);
    const usageRetentionDays = Number.isFinite(configuredUsageRetention) ? Math.max(1, configuredUsageRetention) : retentionDays;
    const removedUsage = defaultStore.pruneRequestTokenUsageOlderThan(Date.now() - usageRetentionDays * 86400000);
    console.log(`[Sessions] SQLite store ready at ${path}${removed ? `; pruned ${removed} stale bindings` : ""}${removedUsage ? `; pruned ${removedUsage} stale usage records` : ""}.`);
  }
  return defaultStore;
}

export function getSessionBinding(sessionKey: string, model: string): SessionBinding | null {
  return initSessionBindingStore().get(sessionKey, model);
}

export function recordSessionBinding(input: RecordBindingInput): SessionBinding {
  return initSessionBindingStore().record(input);
}

export function listSessionBindings(options?: { limit?: number; offset?: number; search?: string }) {
  return initSessionBindingStore().list(options);
}

export function deleteSessionBinding(id: number): boolean {
  return initSessionBindingStore().delete(id);
}

export function clearSessionBindings(): number {
  return initSessionBindingStore().clear();
}

export function deleteSessionBindingsForAccount(email: string): number {
  return initSessionBindingStore().deleteForAccount(email);
}

export function recordRequestTokenUsage(input: RecordRequestTokenUsageInput): RequestTokenUsage {
  return initSessionBindingStore().recordRequestTokenUsage(input);
}

export function listRequestTokenUsage(options?: RequestTokenUsageListOptions) {
  return initSessionBindingStore().listRequestTokenUsage(options);
}

export function clearRequestTokenUsage(): number {
  return initSessionBindingStore().clearRequestTokenUsage();
}
