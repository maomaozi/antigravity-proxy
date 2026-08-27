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
});
