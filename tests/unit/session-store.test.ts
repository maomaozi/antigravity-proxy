import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBindingStore } from "../../src/session/store";
import type { SessionIdentity } from "../../src/session/identity";

const stores: SessionBindingStore[] = [];
const tempDirectories: string[] = [];

function createStore() {
  const store = new SessionBindingStore(":memory:");
  stores.push(store);
  return store;
}

const identity: SessionIdentity = {
  key: "session-key-1",
  id: "ses_123",
  source: "session-id",
  inferred: false,
};

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (tempDirectories.length) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe("session binding store", () => {
  test("persists and updates one binding per session and model", () => {
    const store = createStore();
    const first = store.record({
      identity,
      accountEmail: "first@example.com",
      model: "Claude-Sonnet-4-6",
      modelFamily: "Claude Sonnet 4.6",
      pool: "sandbox",
      projectId: "project-1",
      endpoint: "https://one.example.test/rpc",
    });
    expect(first.requestCount).toBe(1);
    expect(store.get(identity.key, "claude-sonnet-4-6")?.accountEmail).toBe("first@example.com");

    const updated = store.record({
      identity,
      accountEmail: "fallback@example.com",
      model: "claude-sonnet-4-6",
      modelFamily: "Claude Sonnet 4.6",
      pool: "cli",
      projectId: "project-2",
      endpoint: "https://two.example.test/rpc",
    });
    expect(updated.id).toBe(first.id);
    expect(updated.requestCount).toBe(2);
    expect(updated.accountEmail).toBe("fallback@example.com");
    expect(updated.pool).toBe("cli");
  });

  test("keeps separate model bindings and supports search and deletion", () => {
    const store = createStore();
    const first = store.record({
      identity,
      accountEmail: "account@example.com",
      model: "model-a",
      modelFamily: "Family A",
      pool: "sandbox",
    });
    store.record({
      identity,
      accountEmail: "account@example.com",
      model: "model-b",
      modelFamily: "Family B",
      pool: "cli",
    });

    expect(store.list().total).toBe(2);
    expect(store.list({ search: "model-b" }).total).toBe(1);
    expect(store.delete(first.id)).toBe(true);
    expect(store.list().total).toBe(1);
    expect(store.deleteForAccount("account@example.com")).toBe(1);
    expect(store.list().total).toBe(0);
  });

  test("survives closing and reopening the SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "antigravity-session-test-"));
    tempDirectories.push(directory);
    const path = join(directory, "bindings.sqlite");
    const writer = new SessionBindingStore(path);
    writer.record({
      identity,
      accountEmail: "persistent@example.com",
      model: "model-persistent",
      modelFamily: "Persistent Family",
      pool: "sandbox",
    });
    writer.close();

    const reader = new SessionBindingStore(path);
    stores.push(reader);
    expect(reader.get(identity.key, "model-persistent")?.accountEmail).toBe("persistent@example.com");
  });

  test("records one token usage row per request and keeps the richest streaming metadata", () => {
    const store = createStore();
    const base = {
      requestId: "chatcmpl-usage-1",
      identity,
      accountEmail: "usage@example.com",
      model: "Gemini-3.7-Flash",
      modelFamily: "Gemini Models",
      upstreamModel: "gemini-3.7-flash-tiered",
      pool: "sandbox" as const,
      endpoint: "https://example.test/rpc",
      streamed: true,
      inputTokens: 1000,
      outputTokens: 12,
      reasoningTokens: 20,
      reasoningTokensReported: true,
      totalTokens: 1032,
      createdAt: 1_700_000_000_000,
    };

    const initial = store.recordRequestTokenUsage(base);
    expect(initial.cachedInputTokens).toBeNull();
    expect(initial.uncachedInputTokens).toBeNull();

    const updated = store.recordRequestTokenUsage({
      ...base,
      cachedInputTokens: 750,
    });

    expect(updated.model).toBe("gemini-3.7-flash");
    expect(updated.cachedInputTokens).toBe(750);
    expect(updated.uncachedInputTokens).toBe(250);
    expect(updated.reasoningTokens).toBe(20);
    expect(store.listRequestTokenUsage().total).toBe(1);
  });

  test("filters request usage by session, model, time, and search with aggregate totals", () => {
    const store = createStore();
    const otherIdentity: SessionIdentity = {
      key: "session-key-2",
      id: "ses_456",
      source: "x-session-id",
      inferred: false,
    };
    store.recordRequestTokenUsage({
      requestId: "request-a",
      identity,
      accountEmail: "first@example.com",
      model: "model-a",
      modelFamily: "Family A",
      pool: "sandbox",
      streamed: false,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningTokens: 5,
      reasoningTokensReported: true,
      totalTokens: 115,
      createdAt: 1000,
    });
    store.recordRequestTokenUsage({
      requestId: "request-b",
      identity: otherIdentity,
      accountEmail: "second@example.com",
      model: "model-b",
      modelFamily: "Family B",
      pool: "cli",
      streamed: true,
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
      createdAt: 2000,
    });

    const all = store.listRequestTokenUsage();
    expect(all.total).toBe(2);
    expect(all.summary).toEqual({
      requests: 2,
      sessions: 2,
      inputTokens: 300,
      cachedInputTokens: 40,
      uncachedInputTokens: 60,
      cacheReportedRequests: 1,
      cacheReportedInputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 5,
      totalTokens: 335,
      timedRequests: 2,
      outputDurationMs: expect.any(Number),
      averageTokensPerSecond: expect.any(Number),
    });
    const reportedOnly = store.listRequestTokenUsage({ sessionKey: identity.key });
    expect(reportedOnly.total).toBe(1);
    expect(reportedOnly.summary.cachedInputTokens).toBe(40);
    expect(reportedOnly.summary.uncachedInputTokens).toBe(60);
    expect(reportedOnly.summary.cacheReportedRequests).toBe(1);
    expect(reportedOnly.summary.cacheReportedInputTokens).toBe(100);
    expect(store.listRequestTokenUsage({ model: "MODEL-B" }).records[0].requestId).toBe("request-b");
    expect(store.listRequestTokenUsage({ from: 1500, to: 2500 }).total).toBe(1);
    expect(store.listRequestTokenUsage({ search: "first@example.com" }).total).toBe(1);
    expect(store.clearRequestTokenUsage()).toBe(2);
  });

  test("calculates per-request and session-model weighted generated-token speed", () => {
    const store = createStore();
    store.record({
      identity,
      accountEmail: "speed@example.com",
      model: "model-speed",
      modelFamily: "Speed Family",
      pool: "sandbox",
    });

    const usage = store.recordRequestTokenUsage({
      requestId: "request-speed",
      identity,
      accountEmail: "speed@example.com",
      model: "model-speed",
      modelFamily: "Speed Family",
      pool: "sandbox",
      streamed: true,
      inputTokens: 10,
      outputTokens: 100,
      reasoningTokens: 50,
      reasoningTokensReported: true,
      totalTokens: 160,
      createdAt: Date.now() - 1000,
    });

    expect(usage.durationMs).toBeGreaterThanOrEqual(1000);
    expect(usage.tokensPerSecond).toBeGreaterThan(135);
    expect(usage.tokensPerSecond).toBeLessThanOrEqual(150);

    const binding = store.list().bindings[0];
    expect(binding.speedRequestCount).toBe(1);
    expect(binding.averageTokensPerSecond).toBeCloseTo(usage.tokensPerSecond!, 5);
  });
});

describe("Codex session statistics compatibility", () => {
  test("stores Codex compact as a first-class endpoint under the same session", () => {
    const store = createStore();
    const binding = store.record({
      identity,
      accountEmail: "codex@example.com",
      model: "gpt-5-codex",
      modelFamily: "Codex",
      pool: "codex",
      endpoint: "/v1/responses/compact",
      upstreamSessionId: "upstream-session-1",
    });
    const usage = store.recordRequestTokenUsage({
      requestId: "compact-1",
      identity,
      accountEmail: "codex@example.com",
      model: "gpt-5-codex",
      modelFamily: "Codex",
      upstreamModel: "gpt-5-codex",
      pool: "codex",
      endpoint: "/v1/responses/compact",
      streamed: false,
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningTokens: 5,
      reasoningTokensReported: true,
      totalTokens: 115,
    });
    expect(binding.pool).toBe("codex");
    expect(binding.upstreamSessionId).toBe("upstream-session-1");
    expect(usage.endpoint).toBe("/v1/responses/compact");
    expect(store.listRequestTokenUsage({ sessionKey: identity.key }).records[0].requestId).toBe("compact-1");
  });

  test("migrates legacy cli/sandbox CHECK constraints without losing historical rows", async () => {
    const { Database } = await import("bun:sqlite");
    const directory = mkdtempSync(join(tmpdir(), "antigravity-codex-migration-test-"));
    tempDirectories.push(directory);
    const path = join(directory, "legacy.sqlite");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE session_bindings (
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
        pool TEXT NOT NULL CHECK (pool IN ('cli', 'sandbox')),
        endpoint TEXT,
        streamed INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens_reported INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens_reported INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO session_bindings (session_key, session_id, source, inferred, account_email, model, model_family, pool, created_at, updated_at, last_used_at, request_count)
      VALUES ('legacy-key', 'legacy-id', 'legacy', 0, 'legacy@example.com', 'legacy-model', 'Legacy', 'sandbox', 1, 2, 2, 3);
      INSERT INTO request_token_usage (request_id, session_key, session_id, session_source, session_inferred, account_email, model, model_family, pool, streamed, input_tokens, output_tokens, total_tokens, created_at, updated_at)
      VALUES ('legacy-request', 'legacy-key', 'legacy-id', 'legacy', 0, 'legacy@example.com', 'legacy-model', 'Legacy', 'sandbox', 0, 10, 5, 15, 1, 2);
    `);
    db.close();

    const store = new SessionBindingStore(path);
    stores.push(store);
    expect(store.get("legacy-key", "legacy-model")?.requestCount).toBe(3);
    expect(store.listRequestTokenUsage({ sessionKey: "legacy-key" }).records[0].requestId).toBe("legacy-request");
    expect(store.record({
      identity,
      accountEmail: "codex@example.com",
      model: "gpt-5-codex",
      modelFamily: "Codex",
      pool: "codex",
    }).pool).toBe("codex");
  });
});
