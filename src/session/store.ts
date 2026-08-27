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

  delete(id: number): boolean {
    return this.db.query("DELETE FROM session_bindings WHERE id = ?").run(id).changes > 0;
  }

  deleteForAccount(email: string): number {
    return this.db.query("DELETE FROM session_bindings WHERE account_email = ?").run(email).changes;
  }

  clear(): number {
    return this.db.query("DELETE FROM session_bindings").run().changes;
  }

  pruneOlderThan(timestamp: number): number {
    return this.db.query("DELETE FROM session_bindings WHERE updated_at < ?").run(timestamp).changes;
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
    console.log(`[Sessions] SQLite store ready at ${path}${removed ? `; pruned ${removed} stale bindings` : ""}.`);
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
