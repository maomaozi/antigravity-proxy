import { describe, expect, test } from "bun:test";
import { resolveCodexAffinityIdentity, resolveSessionIdentity } from "../../src/session/identity";

describe("session identity resolution", () => {
  test("uses OpenCode affinity ahead of compatibility fields", () => {
    const headers = new Headers({
      "x-session-affinity": "ses_opencode_affinity",
      "x-session-id": "ses_compat",
      "x-opencode-session": "ses_opencode",
    });
    const identity = resolveSessionIdentity(headers, { prompt_cache_key: "cache-key" });
    expect(identity.id).toBe("ses_opencode_affinity");
    expect(identity.source).toBe("x-session-affinity");
    expect(identity.inferred).toBe(false);
  });

  test("uses the standard prompt cache key when no affinity header exists", () => {
    const identity = resolveSessionIdentity(new Headers(), { prompt_cache_key: "cache-key-1" });
    expect(identity.id).toBe("cache-key-1");
    expect(identity.source).toBe("prompt_cache_key");
  });

  test("uses Codex session-id ahead of metadata and thread-id", () => {
    const headers = new Headers({
      "session-id": "codex-session",
      "thread-id": "codex-thread",
      "x-codex-turn-metadata": JSON.stringify({ session_id: "metadata-session" }),
    });
    const identity = resolveSessionIdentity(headers, {});
    expect(identity.id).toBe("codex-session");
    expect(identity.source).toBe("session-id");
  });

  test("reads the Codex metadata fallback safely", () => {
    const headers = new Headers({
      "x-codex-turn-metadata": JSON.stringify({ session_id: "metadata-session", turn_id: "turn-1" }),
      "thread-id": "codex-thread",
    });
    const identity = resolveSessionIdentity(headers, {});
    expect(identity.id).toBe("metadata-session");
    expect(identity.source).toBe("x-codex-turn-metadata");
  });

  test("uses Codex thread-id for account affinity even when the prompt cache key is shared", () => {
    const headers = new Headers({
      "session-id": "codex-session",
      "thread-id": "codex-thread-a",
    });
    const identity = resolveCodexAffinityIdentity(headers, { prompt_cache_key: "codex-session" });
    expect(identity.id).toBe("codex-thread:codex-thread-a");
    expect(identity.source).toBe("thread-id");
    expect(identity.inferred).toBe(false);
  });

  test("keeps explicit session affinity ahead of Codex thread affinity", () => {
    const headers = new Headers({
      "x-session-affinity": "explicit-affinity",
      "thread-id": "codex-thread-a",
    });
    const identity = resolveCodexAffinityIdentity(headers, { prompt_cache_key: "codex-session" });
    expect(identity.id).toBe("explicit-affinity");
    expect(identity.source).toBe("x-session-affinity");
  });

  test("history fallback remains stable as the conversation grows", () => {
    const initial = resolveSessionIdentity(new Headers(), {
      messages: [
        { role: "system", content: "You are a coding agent" },
        { role: "user", content: "Fix the scheduler" },
      ],
    });
    const followup = resolveSessionIdentity(new Headers(), {
      messages: [
        { role: "system", content: "You are a coding agent" },
        { role: "user", content: "Fix the scheduler" },
        { role: "assistant", content: "Working on it" },
        { role: "user", content: "Continue" },
      ],
    });
    expect(initial.source).toBe("history-anchor");
    expect(initial.key).toBe(followup.key);
    expect(initial.inferred).toBe(true);
  });

  test("never collapses requests without a usable identity to unknown", () => {
    const first = resolveSessionIdentity(new Headers(), { messages: [] });
    const second = resolveSessionIdentity(new Headers(), { messages: [] });
    expect(first.id).not.toBe("unknown");
    expect(first.key).not.toBe(second.key);
    expect(first.source).toBe("generated");
  });
});

test("history fallback can use canonical messages for protocol-neutral affinity", () => {
  const chat = resolveSessionIdentity(new Headers(), {
    messages: [
      { role: "system", content: "You are a coding agent" },
      { role: "user", content: "Fix the scheduler" },
    ],
  });
  const responses = resolveSessionIdentity(new Headers(), { input: "wire shape differs" }, [
    { role: "system", content: "You are a coding agent" },
    { role: "user", content: "Fix the scheduler" },
    { role: "assistant", content: "Working on it" },
  ]);
  expect(responses.source).toBe("history-anchor");
  expect(responses.key).toBe(chat.key);
});
