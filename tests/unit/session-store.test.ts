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
