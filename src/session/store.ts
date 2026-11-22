import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionIdentity } from "./identity";

export type SessionPool = "sandbox" | "codex";

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
  upstreamSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
  requestCount: number;
  averageTokensPerSecond: number | null;
  speedRequestCount: number;
}

export interface RecordBindingInput {
  identity: SessionIdentity;
  accountEmail: string;
  model: string;
  modelFamily: string;
  pool: SessionPool;
  projectId?: string;
  endpoint?: string;
  upstreamSessionId?: string;
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
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  outputTokens: number;
  reasoningTokens: number;
  reasoningTokensReported: boolean;
  effort: string | null;
  totalTokens: number;
  createdAt: number;
  updatedAt: number;
  durationMs: number | null;
  tokensPerSecond: number | null;
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
  cachedInputTokens?: number | null;
  outputTokens: number;
  reasoningTokens?: number;
  reasoningTokensReported?: boolean;
  effort?: string | null;
  totalTokens: number;
  createdAt?: number;
  generationDurationMs?: number | null;
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
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReportedRequests: number;
  cacheReportedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  timedRequests: number;
  outputDurationMs: number;
  averageTokensPerSecond: number | null;
}

export type SessionRoutingGuardStatus = "pinned" | "protected_429" | "terminated_tos";

export interface SessionRoutingGuard {
  sessionKey: string;
  model: string;
  accountEmail: string;
  status: SessionRoutingGuardStatus;
  reason: string | null;
  errorCode: string | null;
  errorStatus: number | null;
  errorMessage: string | null;
  appealUrl: string | null;
  retryAt: number | null;
  probeInProgress: boolean;
  requestDigest: string | null;
  attemptsUsed: number;
  accountAttemptsUsed: number;
  accountsTouched: string[];
  budgetExhaustedUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertRoutingGuardInput {
  sessionScopeKey: string;
  digestScopeKey?: string;
  model: string;
  accountEmail: string;
  status?: SessionRoutingGuardStatus;
  reason?: string | null;
  errorCode?: string | null;
  errorStatus?: number | null;
  errorMessage?: string | null;
  appealUrl?: string | null;
  retryAt?: number | null;
  probeInProgress?: boolean;
  requestDigest?: string | null;
  attemptsUsed?: number;
  accountAttemptsUsed?: number;
  accountsTouched?: string[];
  budgetExhaustedUntil?: number | null;
  now?: number;
}

interface RoutingGuardRow {
  session_key: string;
  model: string;
  account_email: string;
  status: SessionRoutingGuardStatus;
  reason: string | null;
  error_code: string | null;
  error_status: number | null;
  error_message: string | null;
  appeal_url: string | null;
  retry_at: number | null;
  probe_in_progress: number;
  request_digest: string | null;
  attempts_used: number;
  account_attempts_used: number;
  accounts_touched: string;
  budget_exhausted_until: number | null;
  created_at: number;
  updated_at: number;
}

function mapGuardRow(row: RoutingGuardRow): SessionRoutingGuard {
  let accountsTouched: string[] = [];
  try {
    const parsed = JSON.parse(row.accounts_touched || "[]");
    if (Array.isArray(parsed)) {
      accountsTouched = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    accountsTouched = [];
  }
  return {
    sessionKey: row.session_key,
    model: row.model,
    accountEmail: row.account_email,
    status: row.status,
    reason: row.reason ?? null,
    errorCode: row.error_code ?? null,
    errorStatus: row.error_status ?? null,
    errorMessage: row.error_message ?? null,
    appealUrl: row.appeal_url ?? null,
    retryAt: row.retry_at ?? null,
    probeInProgress: row.probe_in_progress === 1,
    requestDigest: row.request_digest ?? null,
    attemptsUsed: row.attempts_used ?? 0,
    accountAttemptsUsed: row.account_attempts_used ?? 0,
    accountsTouched,
    budgetExhaustedUntil: row.budget_exhausted_until ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  upstream_session_id: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number;
  request_count: number;
  speed_generated_tokens?: number;
  speed_duration_ms?: number;
  speed_request_count?: number;
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
  cached_input_tokens_reported: number;
  output_tokens: number;
  reasoning_tokens: number;
  reasoning_tokens_reported: number;
  effort?: string | null;
  total_tokens: number;
  created_at: number;
  updated_at: number;
  generation_duration_ms?: number | null;
}

function mapRow(row: BindingRow): SessionBinding {
  const speedDurationMs = row.speed_duration_ms ?? 0;
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
    upstreamSessionId: row.upstream_session_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    requestCount: row.request_count,
    averageTokensPerSecond: speedDurationMs > 0
      ? (row.speed_generated_tokens ?? 0) * 1000 / speedDurationMs
      : null,
    speedRequestCount: row.speed_request_count ?? 0,
  };
}

function mapUsageRow(row: RequestTokenUsageRow): RequestTokenUsage {
  const durationMs = row.generation_duration_ms !== null
    && row.generation_duration_ms !== undefined
    && row.generation_duration_ms > 0
    ? row.generation_duration_ms
    : null;
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
    cachedInputTokens: row.cached_input_tokens_reported === 1 ? row.cached_input_tokens : null,
    uncachedInputTokens: row.cached_input_tokens_reported === 1
      ? Math.max(0, row.input_tokens - row.cached_input_tokens)
      : null,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    reasoningTokensReported: row.reasoning_tokens_reported === 1,
    effort: row.effort ?? null,
    totalTokens: row.total_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    durationMs,
    tokensPerSecond: durationMs !== null && row.output_tokens + row.reasoning_tokens > 0
      ? (row.output_tokens + row.reasoning_tokens) * 1000 / durationMs
      : null,
  };
}

function tokenCount(value: number | null | undefined): number {
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
        pool TEXT NOT NULL CHECK (pool IN ('sandbox', 'codex')),
        project_id TEXT,
        endpoint TEXT,
        upstream_session_id TEXT,
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
        pool TEXT NOT NULL CHECK (pool IN ('sandbox', 'codex')),
        endpoint TEXT,
        streamed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens_reported INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens_reported INTEGER NOT NULL DEFAULT 0,
        effort TEXT,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        generation_duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_session
        ON request_token_usage(session_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_created_at
        ON request_token_usage(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_model
        ON request_token_usage(model, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_account
        ON request_token_usage(account_email, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_token_usage_session_model
        ON request_token_usage(session_key, model);

      CREATE TABLE IF NOT EXISTS session_routing_guards (
        session_key TEXT NOT NULL,
        model TEXT NOT NULL,
        account_email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pinned' CHECK (status IN ('pinned', 'protected_429', 'terminated_tos')),
        reason TEXT,
        error_code TEXT,
        error_status INTEGER,
        error_message TEXT,
        appeal_url TEXT,
        retry_at INTEGER,
        probe_in_progress INTEGER NOT NULL DEFAULT 0,
        request_digest TEXT,
        attempts_used INTEGER NOT NULL DEFAULT 0,
        account_attempts_used INTEGER NOT NULL DEFAULT 0,
        accounts_touched TEXT NOT NULL DEFAULT '[]',
        budget_exhausted_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, model)
      );
      CREATE INDEX IF NOT EXISTS idx_session_routing_guards_account
        ON session_routing_guards(account_email);
      CREATE INDEX IF NOT EXISTS idx_session_routing_guards_updated_at
        ON session_routing_guards(updated_at DESC);
    `);

    let usageColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(request_token_usage)").all();
    if (!usageColumns.some(column => column.name === "cached_input_tokens_reported")) {
      this.db.exec("ALTER TABLE request_token_usage ADD COLUMN cached_input_tokens_reported INTEGER NOT NULL DEFAULT 0;");
      usageColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(request_token_usage)").all();
    }
    this.migrateLegacyPoolConstraints();
    usageColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(request_token_usage)").all();
    if (!usageColumns.some(column => column.name === "effort")) {
      this.db.exec("ALTER TABLE request_token_usage ADD COLUMN effort TEXT;");
      usageColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(request_token_usage)").all();
    }
    if (!usageColumns.some(column => column.name === "generation_duration_ms")) {
      this.db.exec("ALTER TABLE request_token_usage ADD COLUMN generation_duration_ms INTEGER;");
      usageColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(request_token_usage)").all();
    }
    const bindingColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(session_bindings)").all();
    if (!bindingColumns.some(column => column.name === "upstream_session_id")) {
      this.db.exec("ALTER TABLE session_bindings ADD COLUMN upstream_session_id TEXT;");
    }
  }

  private migrateLegacyPoolConstraints(): void {
    const bindingSql = this.db.query<{ sql: string | null }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get("session_bindings")?.sql || "";
    const usageSql = this.db.query<{ sql: string | null }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get("request_token_usage")?.sql || "";
    const migrateBindings = bindingSql.includes("CHECK") && !bindingSql.includes("'codex'");
    const migrateUsage = usageSql.includes("CHECK") && !usageSql.includes("'codex'");
    if (!migrateBindings && !migrateUsage) return;

    // Keep historical pool values during migration; new writes use SessionPool.
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (migrateBindings) {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_session_bindings_updated_at;
          DROP INDEX IF EXISTS idx_session_bindings_account;
          ALTER TABLE session_bindings RENAME TO session_bindings_legacy_pool;
          CREATE TABLE session_bindings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            session_id TEXT NOT NULL,
            source TEXT NOT NULL,
            inferred INTEGER NOT NULL DEFAULT 0,
            account_email TEXT NOT NULL,
            model TEXT NOT NULL,
            model_family TEXT NOT NULL,
            pool TEXT NOT NULL,
            project_id TEXT,
            endpoint TEXT,
            upstream_session_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 1,
            UNIQUE(session_key, model)
          );
          INSERT INTO session_bindings (
            id, session_key, session_id, source, inferred, account_email, model,
            model_family, pool, project_id, endpoint, upstream_session_id,
            created_at, updated_at, last_used_at, request_count
          )
          SELECT
            id, session_key, session_id, source, inferred, account_email, model,
            model_family, pool, project_id, endpoint, NULL,
            created_at, updated_at, last_used_at, request_count
          FROM session_bindings_legacy_pool;
          DROP TABLE session_bindings_legacy_pool;
          CREATE INDEX idx_session_bindings_updated_at ON session_bindings(updated_at DESC);
          CREATE INDEX idx_session_bindings_account ON session_bindings(account_email);
        `);
      }
      if (migrateUsage) {
        this.db.exec(`
          DROP INDEX IF EXISTS idx_request_token_usage_session;
          DROP INDEX IF EXISTS idx_request_token_usage_created_at;
          DROP INDEX IF EXISTS idx_request_token_usage_model;
          DROP INDEX IF EXISTS idx_request_token_usage_account;
          ALTER TABLE request_token_usage RENAME TO request_token_usage_legacy_pool;
          CREATE TABLE request_token_usage (
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
            pool TEXT NOT NULL,
            endpoint TEXT,
            streamed INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            cached_input_tokens INTEGER NOT NULL DEFAULT 0,
            cached_input_tokens_reported INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens_reported INTEGER NOT NULL DEFAULT 0,
            effort TEXT,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            generation_duration_ms INTEGER
          );
          INSERT INTO request_token_usage (
            id, request_id, session_key, session_id, session_source, session_inferred,
            account_email, model, model_family, upstream_model, pool, endpoint,
            streamed, input_tokens, cached_input_tokens, cached_input_tokens_reported,
            output_tokens, reasoning_tokens, reasoning_tokens_reported, effort, total_tokens,
            created_at, updated_at
          )
          SELECT
            id, request_id, session_key, session_id, session_source, session_inferred,
            account_email, model, model_family, upstream_model, pool, endpoint,
            streamed, input_tokens, cached_input_tokens, cached_input_tokens_reported,
            output_tokens, reasoning_tokens, reasoning_tokens_reported, NULL, total_tokens,
            created_at, updated_at
          FROM request_token_usage_legacy_pool;
          DROP TABLE request_token_usage_legacy_pool;
          CREATE INDEX idx_request_token_usage_session ON request_token_usage(session_key, created_at DESC);
          CREATE INDEX idx_request_token_usage_created_at ON request_token_usage(created_at DESC);
          CREATE INDEX idx_request_token_usage_model ON request_token_usage(model, created_at DESC);
          CREATE INDEX idx_request_token_usage_account ON request_token_usage(account_email, created_at DESC);
        `);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
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
        model_family, pool, project_id, endpoint, upstream_session_id, created_at, updated_at,
        last_used_at, request_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(session_key, model) DO UPDATE SET
        session_id = excluded.session_id,
        source = excluded.source,
        inferred = excluded.inferred,
        account_email = excluded.account_email,
        model_family = excluded.model_family,
        pool = excluded.pool,
        project_id = excluded.project_id,
        endpoint = excluded.endpoint,
        upstream_session_id = COALESCE(excluded.upstream_session_id, session_bindings.upstream_session_id),
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
      input.upstreamSessionId ?? null,
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
      ? "WHERE session_bindings.session_id LIKE ? OR session_bindings.account_email LIKE ? OR session_bindings.model LIKE ? OR session_bindings.model_family LIKE ? OR session_bindings.source LIKE ?"
      : "";
    const args = search ? Array(5).fill(`%${search}%`) : [];
    const rows = this.db.query<BindingRow, any[]>(`
      SELECT
        session_bindings.*,
        COALESCE(speed.generated_tokens, 0) AS speed_generated_tokens,
        COALESCE(speed.duration_ms, 0) AS speed_duration_ms,
        COALESCE(speed.request_count, 0) AS speed_request_count
      FROM session_bindings
      LEFT JOIN (
        SELECT
          session_key,
          model,
          SUM(output_tokens + reasoning_tokens) AS generated_tokens,
          SUM(generation_duration_ms) AS duration_ms,
          COUNT(*) AS request_count
        FROM request_token_usage
        WHERE output_tokens + reasoning_tokens > 0 AND generation_duration_ms > 0
        GROUP BY session_key, model
      ) AS speed
        ON speed.session_key = session_bindings.session_key
        AND speed.model = session_bindings.model
      ${where}
      ORDER BY session_bindings.last_used_at DESC
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
    const generationDurationMs = Number.isFinite(input.generationDurationMs) && input.generationDurationMs! > 0
      ? Math.trunc(input.generationDurationMs!)
      : null;
    const model = input.model.toLowerCase();
    this.db.query(`
      INSERT INTO request_token_usage (
        request_id, session_key, session_id, session_source, session_inferred,
        account_email, model, model_family, upstream_model, pool, endpoint,
        streamed, input_tokens, cached_input_tokens, cached_input_tokens_reported,
        output_tokens, reasoning_tokens, reasoning_tokens_reported, effort, total_tokens,
        created_at, updated_at, generation_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        cached_input_tokens_reported = MAX(request_token_usage.cached_input_tokens_reported, excluded.cached_input_tokens_reported),
        output_tokens = MAX(request_token_usage.output_tokens, excluded.output_tokens),
        reasoning_tokens = MAX(request_token_usage.reasoning_tokens, excluded.reasoning_tokens),
        reasoning_tokens_reported = MAX(request_token_usage.reasoning_tokens_reported, excluded.reasoning_tokens_reported),
        effort = COALESCE(excluded.effort, request_token_usage.effort),
        total_tokens = MAX(request_token_usage.total_tokens, excluded.total_tokens),
        updated_at = excluded.updated_at,
        generation_duration_ms = CASE
          WHEN excluded.generation_duration_ms IS NOT NULL
            AND (request_token_usage.generation_duration_ms IS NULL OR excluded.generation_duration_ms > request_token_usage.generation_duration_ms)
          THEN excluded.generation_duration_ms
          ELSE request_token_usage.generation_duration_ms
        END
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
      input.cachedInputTokens === null || input.cachedInputTokens === undefined ? 0 : 1,
      tokenCount(input.outputTokens),
      tokenCount(input.reasoningTokens),
      input.reasoningTokensReported ? 1 : 0,
      input.effort ?? null,
      tokenCount(input.totalTokens),
      createdAt,
      now,
      generationDurationMs,
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
      clauses.push("(request_id LIKE ? OR session_id LIKE ? OR account_email LIKE ? OR model LIKE ? OR model_family LIKE ? OR session_source LIKE ? OR effort LIKE ?)");
      args.push(...Array(7).fill(`%${search}%`));
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
      cached_input_tokens_reported: number;
      cache_reported_input_tokens: number;
      uncached_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      total_tokens: number;
      timed_requests: number;
      speed_generated_tokens: number;
      output_duration_ms: number;
    }, any[]>(`
      SELECT
        COUNT(*) AS requests,
        COUNT(DISTINCT session_key) AS sessions,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(cached_input_tokens_reported), 0) AS cached_input_tokens_reported,
        COALESCE(SUM(CASE WHEN cached_input_tokens_reported = 1 THEN input_tokens ELSE 0 END), 0) AS cache_reported_input_tokens,
        COALESCE(SUM(CASE WHEN cached_input_tokens_reported = 1 THEN MAX(0, input_tokens - cached_input_tokens) ELSE 0 END), 0) AS uncached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(CASE WHEN output_tokens + reasoning_tokens > 0 AND generation_duration_ms > 0 THEN 1 ELSE 0 END), 0) AS timed_requests,
        COALESCE(SUM(CASE WHEN output_tokens + reasoning_tokens > 0 AND generation_duration_ms > 0 THEN output_tokens + reasoning_tokens ELSE 0 END), 0) AS speed_generated_tokens,
        COALESCE(SUM(CASE WHEN output_tokens + reasoning_tokens > 0 AND generation_duration_ms > 0 THEN generation_duration_ms ELSE 0 END), 0) AS output_duration_ms
      FROM request_token_usage ${where}
    `).get(...args);
    const requests = aggregate?.requests ?? 0;
    const cacheReportedRequests = aggregate?.cached_input_tokens_reported ?? 0;
    const hasCacheMetadata = requests === 0 || cacheReportedRequests > 0;
    const cachedInputTokens = hasCacheMetadata ? (aggregate?.cached_input_tokens ?? 0) : null;
    const outputDurationMs = aggregate?.output_duration_ms ?? 0;

    return {
      records: rows.map(mapUsageRow),
      total: requests,
      summary: {
        requests,
        sessions: aggregate?.sessions ?? 0,
        inputTokens: aggregate?.input_tokens ?? 0,
        cachedInputTokens,
        uncachedInputTokens: hasCacheMetadata ? (aggregate?.uncached_input_tokens ?? 0) : null,
        cacheReportedRequests,
        cacheReportedInputTokens: aggregate?.cache_reported_input_tokens ?? 0,
        outputTokens: aggregate?.output_tokens ?? 0,
        reasoningTokens: aggregate?.reasoning_tokens ?? 0,
        totalTokens: aggregate?.total_tokens ?? 0,
        timedRequests: aggregate?.timed_requests ?? 0,
        outputDurationMs,
        averageTokensPerSecond: outputDurationMs > 0
          ? (aggregate?.speed_generated_tokens ?? 0) * 1000 / outputDurationMs
          : null,
      },
    };
  }

  delete(id: number): boolean {
    return this.db.query("DELETE FROM session_bindings WHERE id = ?").run(id).changes > 0;
  }

  getRoutingGuard(sessionKey: string, model: string): SessionRoutingGuard | null {
    const row = this.db.query<RoutingGuardRow, [string, string]>(`
      SELECT * FROM session_routing_guards
      WHERE session_key = ? AND model = ?
      LIMIT 1
    `).get(sessionKey, model.toLowerCase());
    return row ? mapGuardRow(row) : null;
  }

  findRoutingGuard(sessionScopeKey: string, digestScopeKey: string | undefined, model: string): SessionRoutingGuard | null {
    const primary = this.getRoutingGuard(sessionScopeKey, model);
    if (primary) return primary;
    if (digestScopeKey && digestScopeKey !== sessionScopeKey) {
      return this.getRoutingGuard(digestScopeKey, model);
    }
    return null;
  }

  upsertRoutingGuard(input: UpsertRoutingGuardInput): SessionRoutingGuard {
    const now = Number.isFinite(input.now) ? Math.trunc(input.now!) : Date.now();
    const model = input.model.toLowerCase();
    const status = input.status ?? "pinned";
    const accountsTouchedJson = JSON.stringify(
      Array.isArray(input.accountsTouched) && input.accountsTouched.length > 0
        ? [...new Set(input.accountsTouched)]
        : [input.accountEmail],
    );

    const writeKey = (key: string) => {
      this.db.query(`
        INSERT INTO session_routing_guards (
          session_key, model, account_email, status, reason, error_code, error_status,
          error_message, appeal_url, retry_at, probe_in_progress, request_digest,
          attempts_used, account_attempts_used, accounts_touched, budget_exhausted_until,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key, model) DO UPDATE SET
          account_email = excluded.account_email,
          status = excluded.status,
          reason = excluded.reason,
          error_code = excluded.error_code,
          error_status = excluded.error_status,
          error_message = excluded.error_message,
          appeal_url = excluded.appeal_url,
          retry_at = excluded.retry_at,
          probe_in_progress = excluded.probe_in_progress,
          request_digest = COALESCE(excluded.request_digest, session_routing_guards.request_digest),
          attempts_used = excluded.attempts_used,
          account_attempts_used = excluded.account_attempts_used,
          accounts_touched = excluded.accounts_touched,
          budget_exhausted_until = excluded.budget_exhausted_until,
          updated_at = excluded.updated_at
      `).run(
        key,
        model,
        input.accountEmail,
        status,
        input.reason ?? null,
        input.errorCode ?? null,
        input.errorStatus ?? null,
        input.errorMessage ?? null,
        input.appealUrl ?? null,
        input.retryAt ?? null,
        input.probeInProgress ? 1 : 0,
        input.requestDigest ?? null,
        Math.max(0, Math.trunc(input.attemptsUsed ?? 0)),
        Math.max(0, Math.trunc(input.accountAttemptsUsed ?? 0)),
        accountsTouchedJson,
        input.budgetExhaustedUntil ?? null,
        now,
        now,
      );
    };

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      writeKey(input.sessionScopeKey);
      if (input.digestScopeKey && input.digestScopeKey !== input.sessionScopeKey) {
        writeKey(input.digestScopeKey);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    return this.getRoutingGuard(input.sessionScopeKey, model)!;
  }

  tryAcquireRoutingGuardProbe(
    sessionScopeKey: string,
    digestScopeKey: string | undefined,
    model: string,
    now = Date.now(),
  ): boolean {
    const normalizedModel = model.toLowerCase();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = this.db.query(`
        UPDATE session_routing_guards
        SET probe_in_progress = 1, updated_at = ?
        WHERE session_key = ?
          AND model = ?
          AND status = 'protected_429'
          AND retry_at IS NOT NULL
          AND retry_at <= ?
          AND probe_in_progress = 0
      `).run(now, sessionScopeKey, normalizedModel, now);

      if (result.changes > 0) {
        if (digestScopeKey && digestScopeKey !== sessionScopeKey) {
          this.db.query(`
            UPDATE session_routing_guards
            SET probe_in_progress = 1, updated_at = ?
            WHERE session_key = ? AND model = ?
          `).run(now, digestScopeKey, normalizedModel);
        }
        this.db.exec("COMMIT;");
        return true;
      }

      if (digestScopeKey && digestScopeKey !== sessionScopeKey) {
        const fallbackResult = this.db.query(`
          UPDATE session_routing_guards
          SET probe_in_progress = 1, updated_at = ?
          WHERE session_key = ?
            AND model = ?
            AND status = 'protected_429'
            AND retry_at IS NOT NULL
            AND retry_at <= ?
            AND probe_in_progress = 0
        `).run(now, digestScopeKey, normalizedModel, now);
        if (fallbackResult.changes > 0) {
          this.db.exec("COMMIT;");
          return true;
        }
      }

      this.db.exec("COMMIT;");
      return false;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  releaseRoutingGuardProbe(
    sessionScopeKey: string,
    digestScopeKey: string | undefined,
    model: string,
    now = Date.now(),
  ): void {
    const normalizedModel = model.toLowerCase();
    this.db.query(`
      UPDATE session_routing_guards
      SET probe_in_progress = 0, updated_at = ?
      WHERE session_key = ? AND model = ?
    `).run(now, sessionScopeKey, normalizedModel);
    if (digestScopeKey && digestScopeKey !== sessionScopeKey) {
      this.db.query(`
        UPDATE session_routing_guards
        SET probe_in_progress = 0, updated_at = ?
        WHERE session_key = ? AND model = ?
      `).run(now, digestScopeKey, normalizedModel);
    }
  }

  deleteRoutingGuard(sessionScopeKey: string, digestScopeKey: string | undefined, model: string): void {
    const normalizedModel = model.toLowerCase();
    this.db.query("DELETE FROM session_routing_guards WHERE session_key = ? AND model = ?").run(
      sessionScopeKey,
      normalizedModel,
    );
    if (digestScopeKey && digestScopeKey !== sessionScopeKey) {
      this.db.query("DELETE FROM session_routing_guards WHERE session_key = ? AND model = ?").run(
        digestScopeKey,
        normalizedModel,
      );
    }
  }

  clearTerminatedTosGuardsForAccount(email: string): number {
    return this.db.query(
      "DELETE FROM session_routing_guards WHERE account_email = ? AND status = 'terminated_tos'",
    ).run(email).changes;
  }

  deleteForAccount(email: string, pool?: SessionPool): number {
    if (pool) {
      if (pool === "sandbox") {
        this.db.query("DELETE FROM session_routing_guards WHERE account_email = ?").run(email);
      }
      return this.db.query("DELETE FROM session_bindings WHERE account_email = ? AND pool = ?").run(email, pool).changes;
    }
    this.db.query("DELETE FROM session_routing_guards WHERE account_email = ?").run(email);
    return this.db.query("DELETE FROM session_bindings WHERE account_email = ?").run(email).changes;
  }

  clear(): number {
    this.db.query("DELETE FROM session_routing_guards").run();
    return this.db.query("DELETE FROM session_bindings").run().changes;
  }

  clearRequestTokenUsage(): number {
    return this.db.query("DELETE FROM request_token_usage").run().changes;
  }

  pruneOlderThan(timestamp: number): number {
    this.db.query("DELETE FROM session_routing_guards WHERE updated_at < ? AND status != 'terminated_tos'").run(timestamp);
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

export function deleteSessionBindingsForAccount(email: string, pool?: SessionPool): number {
  return initSessionBindingStore().deleteForAccount(email, pool);
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

export function getSessionRoutingGuard(sessionKey: string, model: string): SessionRoutingGuard | null {
  return initSessionBindingStore().getRoutingGuard(sessionKey, model);
}

export function findSessionRoutingGuard(
  sessionScopeKey: string,
  digestScopeKey: string | undefined,
  model: string,
): SessionRoutingGuard | null {
  return initSessionBindingStore().findRoutingGuard(sessionScopeKey, digestScopeKey, model);
}

export function upsertSessionRoutingGuard(input: UpsertRoutingGuardInput): SessionRoutingGuard {
  return initSessionBindingStore().upsertRoutingGuard(input);
}

export function tryAcquireSessionRoutingGuardProbe(
  sessionScopeKey: string,
  digestScopeKey: string | undefined,
  model: string,
  now?: number,
): boolean {
  return initSessionBindingStore().tryAcquireRoutingGuardProbe(sessionScopeKey, digestScopeKey, model, now);
}

export function releaseSessionRoutingGuardProbe(
  sessionScopeKey: string,
  digestScopeKey: string | undefined,
  model: string,
  now?: number,
): void {
  initSessionBindingStore().releaseRoutingGuardProbe(sessionScopeKey, digestScopeKey, model, now);
}

export function deleteSessionRoutingGuard(
  sessionScopeKey: string,
  digestScopeKey: string | undefined,
  model: string,
): void {
  initSessionBindingStore().deleteRoutingGuard(sessionScopeKey, digestScopeKey, model);
}

export function clearTerminatedTosGuardsForAccount(email: string): number {
  return initSessionBindingStore().clearTerminatedTosGuardsForAccount(email);
}
