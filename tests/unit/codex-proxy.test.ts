import { describe, expect, test } from "bun:test";
import { CodexProxyService } from "../../src/codex/proxy";
import { CodexAccountManager } from "../../src/codex/account-manager";
import { SessionBindingStore } from "../../src/session/store";
import type { SessionIdentity } from "../../src/session/identity";

const identity: SessionIdentity = { key: "codex-session-key", id: "thread-1", source: "prompt_cache_key", inferred: false };

async function makeManager(fetchImpl: typeof fetch) {
  const manager = new CodexAccountManager({ storagePath: ":memory:", fetchImpl });
  await manager.init();
  await manager.upsertCredentials({
    email: "codex@example.com",
    accountId: "acct_1",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600_000,
  });
  return manager;
}

describe("CodexProxyService", () => {
  test("streams /v1/responses byte-for-byte and records normalized usage under the session", async () => {
    const raw = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":31,"input_tokens_details":{"cached_tokens":7},"output_tokens":21,"output_tokens_details":{"reasoning_tokens":13},"total_tokens":52}}}\n\n';
    const fakeFetch = (async () => new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const manager = await makeManager(fakeFetch);
    const store = new SessionBindingStore(":memory:");
    const service = new CodexProxyService({ manager, store, fetchImpl: fakeFetch, maxAttempts: 1 });

    const response = await service.responses({
      body: { model: "gpt-5-codex", input: "hi", stream: true },
      model: "gpt-5-codex",
      identity,
      requestId: "resp-request-1",
      requestStartedAt: Date.now() - 50,
    });
    expect(await response.text()).toBe(raw);
    const binding = store.get(identity.key, "gpt-5-codex");
    expect(binding?.pool).toBe("codex");
    expect(binding?.endpoint).toBe("/v1/responses");
    expect(binding?.upstreamSessionId).toBeTruthy();
    const usage = store.listRequestTokenUsage({ sessionKey: identity.key }).records[0];
    expect(usage.endpoint).toBe("/v1/responses");
    expect(usage.inputTokens).toBe(31);
    expect(usage.cachedInputTokens).toBe(7);
    expect(usage.outputTokens).toBe(8);
    expect(usage.reasoningTokens).toBe(13);
    store.close();
  });

  test("rewrites the upstream prompt cache key to the Codex thread id", async () => {
    let upstreamBody: any;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body || "{}"));
      return new Response(
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const manager = await makeManager(fakeFetch);
    const store = new SessionBindingStore(":memory:");
    const service = new CodexProxyService({ manager, store, fetchImpl: fakeFetch, maxAttempts: 1 });

    const response = await service.responses({
      body: { model: "gpt-5-codex", input: "hi", stream: true, prompt_cache_key: "shared-session" },
      model: "gpt-5-codex",
      identity,
      threadId: "thread-a",
      requestId: "thread-cache-key-1",
      requestStartedAt: Date.now(),
    });
    await response.text();
    expect(upstreamBody.prompt_cache_key).toBe("thread:thread-a");
    store.close();
  });

  test("aggregates non-stream Responses while retaining canonical output and usage", async () => {
    const raw = [
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
    ].join("");
    const fakeFetch = (async () => new Response(raw, { status: 200 })) as unknown as typeof fetch;
    const manager = await makeManager(fakeFetch);
    const store = new SessionBindingStore(":memory:");
    const service = new CodexProxyService({ manager, store, fetchImpl: fakeFetch, maxAttempts: 1 });
    const response = await service.responses({
      body: { model: "gpt-5-codex", input: "hi", stream: false },
      model: "gpt-5-codex",
      identity,
      requestId: "resp-request-2",
      requestStartedAt: Date.now() - 20,
    });
    expect(await response.json()).toMatchObject({ id: "resp_1", output: [{ id: "msg_1" }] });
    expect(store.listRequestTokenUsage().records[0]).toMatchObject({ streamed: false, totalTokens: 5, endpoint: "/v1/responses" });
    store.close();
  });

  test("records Compact usage as a peer endpoint under the same session", async () => {
    const fakeFetch = (async () => Response.json({
      id: "cmp_1",
      output: [{ type: "compaction", encrypted_content: "opaque" }],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 15,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 115,
      },
    })) as unknown as typeof fetch;
    const manager = await makeManager(fakeFetch);
    const store = new SessionBindingStore(":memory:");
    const service = new CodexProxyService({ manager, store, fetchImpl: fakeFetch, maxAttempts: 1 });

    const response = await service.compact({
      body: { model: "gpt-5-codex", input: [] },
      model: "gpt-5-codex",
      identity,
      requestId: "compact-request-1",
      requestStartedAt: Date.now() - 20,
    });
    expect(((await response.json()) as any).id).toBe("cmp_1");
    const usage = store.listRequestTokenUsage({ sessionKey: identity.key }).records[0];
    expect(usage).toMatchObject({
      requestId: "compact-request-1",
      endpoint: "/v1/responses/compact",
      pool: "codex",
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 115,
    });
    expect(store.get(identity.key, "gpt-5-codex")?.endpoint).toBe("/v1/responses/compact");
    store.close();
  });

  test("normalizes Codex model-capacity errors to 429 and cools down the account", async () => {
    const fakeFetch = (async () => new Response(
      JSON.stringify({ error: { message: "Selected model is at capacity. Please try a different model." } }),
      { status: 400 },
    )) as unknown as typeof fetch;
    const manager = await makeManager(fakeFetch);
    const store = new SessionBindingStore(":memory:");
    const service = new CodexProxyService({ manager, store, fetchImpl: fakeFetch, maxAttempts: 1 });

    const response = await service.compact({
      body: { model: "gpt-5-codex", input: [] },
      model: "gpt-5-codex",
      identity,
      requestId: "capacity-1",
      requestStartedAt: Date.now(),
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(manager.listPublic()[0].available).toBe(false);
    store.close();
  });

  test("refreshes once on 401 and retries the same account", async () => {
    let upstreamCalls = 0;
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) return Response.json({ access_token: "fresh", refresh_token: "refresh-2", expires_in: 3600 });
      upstreamCalls++;
      if (upstreamCalls === 1) return new Response('{"error":{"message":"expired"}}', { status: 401 });
      return Response.json({ id: "cmp_ok", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }) as unknown as typeof fetch;
    const manager = await makeManager(fakeFetch);
    const store = new SessionBindingStore(":memory:");
    const service = new CodexProxyService({ manager, store, fetchImpl: fakeFetch, maxAttempts: 2 });
    const response = await service.compact({ body: { model: "gpt-5-codex", input: [] }, model: "gpt-5-codex", identity, requestId: "retry-1", requestStartedAt: Date.now() });
    expect(response.status).toBe(200);
    expect(upstreamCalls).toBe(2);
    store.close();
  });
});
