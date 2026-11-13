import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { buildCompletionFailure, executeCompletion, resolveTimeouts } from "../../src/api/completion-executor";
import { getAccounts, getAccountSelectionFailure, markCooldown, clearCooldown, getBestAccount, prepareAccountForRequest, resetAccount, setAccountDisabled, suspendAccountPool } from "../../src/auth/manager";
import { collectCompletionStream } from "../../src/core/completion";
import { ANTIGRAVITY_CLIENT_VERSION, getAccountModelPool, isAccountPoolSuspended } from "../../src/models";
import { deleteSessionBindingsForAccount, getSessionBinding, recordSessionBinding } from "../../src/session/store";
import type { AntigravityAccount } from "../../src/auth/types";
import * as storage from "../../src/auth/storage";
import { getProxyConfig } from "../../src/config/manager";
import { fetchQuota, fetchQuotaWindows } from "../../src/api/quota";
import { activateGoogleGeminiWindow, activateGoogleModelWindow } from "../../src/api/window-activation";
import { ANTIGRAVITY_STREAM_URL } from "../../src/api/endpoints";

describe("completion executor timeouts resolution", () => {
  test("defaults to 120s for first byte and 900s for stream when no config provided", () => {
    const timeouts = resolveTimeouts("antigravity-gemini-3.8-flash");
    expect(timeouts.firstByteMs).toBe(120_000);
    expect(timeouts.streamMs).toBe(900_000);
  });

  test("resolves default config with 120s first byte and 900s stream", () => {
    const configTimeouts = {
      default: 120_000,
      firstByte: 120_000,
      stream: 900_000,
      claude: 120_000,
      "gemini-3-pro": 120_000,
      "gemini-3.1-pro": 120_000,
      thinking: 180_000,
    };

    const flashTimeouts = resolveTimeouts("antigravity-gemini-3.8-flash", configTimeouts);
    expect(flashTimeouts.firstByteMs).toBe(120_000);
    expect(flashTimeouts.streamMs).toBe(900_000);

    const thinkingTimeouts = resolveTimeouts("antigravity-claude-opus-4-6-thinking", configTimeouts);
    expect(thinkingTimeouts.firstByteMs).toBe(180_000);
    expect(thinkingTimeouts.streamMs).toBe(900_000);
  });

  test("supports custom stream and firstByte overrides", () => {
    const customTimeouts = {
      firstByte: 60_000,
      stream: 600_000,
    };
    const result = resolveTimeouts("some-custom-model", customTimeouts);
    expect(result.firstByteMs).toBe(60_000);
    expect(result.streamMs).toBe(600_000);
  });
});

describe("completion failure classification", () => {
  const model = "antigravity-gemini-3.8-flash";
  let originalAccounts: AntigravityAccount[];
  let saveSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let originalMaxAttempts: number;
  let originalJitter: boolean;

  function account(email = "failure-test@example.com"): AntigravityAccount {
    return {
      email, refreshToken: "refresh", accessToken: "access",
      expiresAt: Date.now() + 3600_000, projectId: "project",
      healthScore: 100, lastUsed: 0, tokenUsage: 0,
    };
  }

  beforeEach(() => {
    originalAccounts = [...getAccounts()];
    getAccounts().splice(0, getAccounts().length, account());
    saveSpy = spyOn(storage, "saveConfig").mockResolvedValue(undefined);
    const config = getProxyConfig();
    originalMaxAttempts = config.retry.maxAttempts;
    originalJitter = config.features.jitterEnabled;
    config.retry.maxAttempts = 1;
    config.features.jitterEnabled = false;
  });

  afterEach(() => {
    clearCooldown("failure-test@example.com", "sandbox", "Gemini Models");
    deleteSessionBindingsForAccount("failure-test@example.com");
    getAccounts().splice(0, getAccounts().length, ...originalAccounts);
    getProxyConfig().retry.maxAttempts = originalMaxAttempts;
    getProxyConfig().features.jitterEnabled = originalJitter;
    saveSpy.mockRestore();
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  async function run() {
    const result = await executeCompletion({
      request: { model, messages: [{ role: "user", content: "OK" }], stream: false },
      sessionIdentity: { key: "failure-regression", id: "failure-regression", source: "test", inferred: false },
      requestId: "failure-test", requestStartedAt: Date.now(),
    });
    if (result.kind !== "error") throw new Error("Expected completion failure");
    return { status: result.response.status, body: await result.response.json() as any };
  }

  test.each([
    ["antigravity-gemini-3.8-flash", "gemini-3.8-flash-tiered"],
    ["antigravity-gemini-3.5-flash-lite", "gemini-3.5-flash-lite"],
    ["antigravity-gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
    ["antigravity-gemini-3-flash", "gemini-3-flash"],
    ["antigravity-claude-sonnet-4-6-thinking", "claude-sonnet-4-6"],
    ["antigravity-claude-opus-4-6-thinking", "claude-opus-4-6-thinking"],
    ["antigravity-gpt-oss-120b", "gpt-oss-120b-medium"],
    ["gemini-2.5-flash", "gemini-2.5-flash"],
  ])("preserves Antigravity requests and session affinity for %s", async (model, upstreamModel) => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    for (const stream of [false, true]) {
      fetchSpy.mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
      const execution = await executeCompletion({
        request: { model, messages: [{ role: "user", content: "OK" }], stream },
        sessionIdentity: { key: "routing-regression", id: "routing-regression", source: "test", inferred: false },
        requestId: "routing-test", requestStartedAt: Date.now(),
      });
      const result = execution.kind === "stream" ? await collectCompletionStream(execution.stream)
        : execution.kind === "result" ? execution.result : null;
      expect(result?.text).toBe("OK");
      expect(getSessionBinding("routing-regression", model)).toMatchObject({
        pool: "sandbox", accountEmail: "failure-test@example.com", projectId: "project",
      });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(url).toBe(ANTIGRAVITY_STREAM_URL);
      expect(JSON.parse(String(init?.body))).toMatchObject({ project: "project", model: upstreamModel });
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer access");
      expect(headers.get("User-Agent")).toStartWith(`antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} `);
      expect(headers.get("anthropic-beta")).toBeNull();
      expect(headers.get("Client-Metadata")).toBeNull();
    }
  });

  test.each([false, true])("routes Argon requests only to an advertising account and respects reasoning effort (stream=%s)", async stream => {
    const ordinary = getAccounts()[0]!;
    ordinary.availableModels = [{ id: "gemini-3-flash", name: "Gemini 3 Flash" }];
    const special = account("argon-test@example.com");
    special.availableModels = ["low", "high"].map(tier => ({ id: `gemini-4-argon-${tier}`, name: `Gemini 4 Argon (${tier})`, supportsThinking: true }));
    getAccounts().push(special);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    ));
    try {
      const execution = await executeCompletion({
        request: { model: "antigravity-gemini-4-argon", reasoningEffort: "low", messages: [{ role: "user", content: "hi" }], stream },
        sessionIdentity: { key: "argon-regression", id: "argon-regression", source: "test", inferred: false },
        requestId: "argon-test", requestStartedAt: Date.now(),
      });
      const result = execution.kind === "stream" ? await collectCompletionStream(execution.stream)
        : execution.kind === "result" ? execution.result : null;
      expect(result?.text).toBe("OK");
      const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
      expect(body.model).toBe("gemini-4-argon-low");
      expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe("LOW");
      expect(getSessionBinding("argon-regression", "antigravity-gemini-4-argon")?.accountEmail).toBe(special.email);
    } finally { deleteSessionBindingsForAccount(special.email); }
  });

  test.each(["gemini-4-argon-low", "claude-opus-5-5-high"])("activates the discovered model %s and refreshes its quotas and windows", async id => {
    const a = getAccounts()[0]!;
    a.availableModels = [{ id, name: id, supportsThinking: true }];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("fetchAvailableModels")) return Response.json({ models: {
        [id]: { displayName: id, supportsThinking: true, quotaInfo: { remainingFraction: 0.99, resetTime: "3600s" } },
      } });
      if (String(input).includes("retrieveUserQuotaSummary")) return Response.json({ groups: [
        { displayName: id.includes("argon") ? "Gemini 4 Argon" : "Claude and GPT models", buckets: [{ window: "weekly", remainingFraction: 0.99 }] },
      ] });
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "." }] }, finishReason: "STOP" }] });
    }) as unknown as typeof fetch);
    expect(await activateGoogleModelWindow(a, id)).toBe(true);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).model).toBe(id);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(a.quota?.[0]?.remainingFraction).toBe(0.99);
    expect(a.quotaWindows?.[0]?.remainingFraction).toBe(0.99);
    expect(saveSpy).toHaveBeenCalled();
  });

  test("cached model rejection returns 404 without making a Google request", async () => {
    getAccounts()[0].capabilities = { [model]: false };
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const result = await run();
    expect(result.status).toBe(404);
    expect(result.body.error).toMatchObject({ type: "invalid_request_error", code: "model_not_found", attempts: [] });
    expect(result.body.error.message).toContain(model);
    expect(result.body.error.message).not.toContain("Quota");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("initial upstream 404 and later cached rejection retain the same model error", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." },
    }, { status: 404 }));
    const first = await run();
    const cached = await run();
    expect(first.status).toBe(404);
    expect(first.body.error.code).toBe("model_not_found");
    expect(first.body.error.attempts[0]).toMatchObject({ status: 404, reason: "model_not_found" });
    expect(cached.status).toBe(404);
    expect(cached.body.error.code).toBe("model_not_found");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("no configured accounts returns a service error instead of quota exceeded", async () => {
    getAccounts().splice(0);
    const result = await run();
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("no_accounts");
  });

  test("challenged accounts return verification required", async () => {
    getAccounts()[0].challenge = { type: "CAPTCHA", url: "https://example.com", detectedAt: Date.now() };
    const result = await run();
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("account_verification_required");
  });

  test("third-party pool suspension blocks aliases and siblings but preserves Gemini and dedicated pools", async () => {
    const first = getAccounts()[0]!;
    first.quotaWindows = [
      {groupName: 'Gemini Models', window: 'weekly', remainingFraction: 1},
      {groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: 1},
    ];
    recordSessionBinding({ identity: {key:'pool-sticky', id:'pool-sticky', source:'test', inferred:false},
      accountEmail:first.email, model:'antigravity-claude-opus-4-6-thinking', modelFamily:'Claude Opus 4.6', pool:'sandbox' });
    await suspendAccountPool(first.email, 'claude-sonnet-4-6', {reason:'tos_violation'});
    expect(getAccountModelPool(first, 'antigravity-claude-opus-4-6-thinking')).toBe('Claude and GPT models');
    for (const blocked of ['antigravity-claude-sonnet-4-6-thinking', 'claude-opus-4-6-thinking', 'antigravity-gpt-oss-120b']) {
      expect(await getBestAccount('sandbox', blocked, 'pool-sticky')).toBeNull();
      expect(getAccountSelectionFailure('sandbox', blocked)).toBe('pool_suspended');
    }
    expect((await getBestAccount('sandbox', model))?.email).toBe(first.email);
    // Suspensions cannot be erased by a health reset or a successful catalog refresh.
    await resetAccount(first.email);
    expect(isAccountPoolSuspended(first, 'claude-sonnet-4-6')).toBe(true);
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({models:{'claude-sonnet-4-6':{}}}));
    await fetchQuota(first);
    expect(isAccountPoolSuspended(first, 'claude-sonnet-4-6')).toBe(true);
  });

  test("a dedicated Argon pool remains independent from Gemini's shared pool", async () => {
    const first = getAccounts()[0]!;
    first.availableModels = [{id:'gemini-4-argon-high',name:'Gemini 4 Argon (High)'}, {id:'gemini-3.8-flash-tiered',name:'Gemini 3.8 Flash'}];
    first.quota = [{groupName:'Gemini 4 Argon (High)',modelId:'gemini-4-argon-high',limitName:'Gemini 4 Argon',limit:'',usage:'',quotaLeft:'100%',resetIn:'Ready',remainingFraction:1}];
    first.quotaWindows = [{groupName:'Gemini Models',window:'weekly',remainingFraction:1}, {groupName:'Gemini 4 Argon',window:'weekly',remainingFraction:1}];
    await suspendAccountPool(first.email, 'gemini-4-argon-high', {reason:'tos_violation'});
    expect(getAccountModelPool(first, 'antigravity-gemini-4-argon')).toBe('Gemini 4 Argon');
    expect(await getBestAccount('sandbox', 'antigravity-gemini-4-argon',undefined,[],true,undefined,undefined,'high')).toBeNull();
    expect((await getBestAccount('sandbox', model))?.email).toBe(first.email);
  });

  test("a failed recovery renews only that pool's retry deadline", async () => {
    const first = getAccounts()[0]!;
    await suspendAccountPool(first.email, model, {reason:'tos_violation'});
    first.poolSuspensions!['Gemini Models']!.retryAt = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(suspensionResponse());
    await expect(activateGoogleModelWindow(first, model)).rejects.toThrow('403');
    expect(first.poolSuspensions!['Gemini Models']!.retryAt).toBeGreaterThan(Date.now());
    expect(first.disabled).not.toBe(true);
    expect((await getBestAccount('sandbox', 'claude-sonnet-4-6'))?.email).toBe(first.email);
  });

  test("expired suspension is retried and cleared by a successful generation", async () => {
    const first = getAccounts()[0]!;
    await suspendAccountPool(first.email, model, {reason:'tos_violation'});
    first.poolSuspensions!['Gemini Models']!.retryAt = Date.now() - 1;
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `data: ${JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'OK'}]},finishReason:'STOP'}]})}\n\n`,
      {headers:{'Content-Type':'text/event-stream'}},
    ));
    const result = await executeCompletion({request:{model,messages:[{role:'user',content:'OK'}],stream:false},
      sessionIdentity:{key:'pool-recovery',id:'pool-recovery',source:'test',inferred:false},requestId:'pool-recovery',requestStartedAt:Date.now()});
    expect(result.kind).toBe('result');
    expect(first.poolSuspensions).toEqual({});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  function suspensionResponse() {
    return Response.json({ error: {
      code: 403, status: "PERMISSION_DENIED", message: "Service disabled for violation of Terms of Service.",
      details: [{ reason: "TOS_VIOLATION", metadata: { appeal_url: "https://forms.gle/appeal" } }],
    } }, { status: 403 });
  }

  test("pool suspension is persisted and subsequent requests skip only that pool", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(suspensionResponse());
    expect((await run()).body.error.code).toBe("pool_suspended");
    expect(getAccounts()[0]!.disabled).not.toBe(true);
    expect(getAccounts()[0]!.poolSuspensions?.['Gemini Models']).toMatchObject({
      reason: "tos_violation", appealUrl: "https://forms.gle/appeal", model: 'gemini-3.8-flash-tiered',
    });
    expect(saveSpy).toHaveBeenCalled();
    const cached = await run();
    expect(cached.status).toBe(403);
    expect(cached.body.error.code).toBe("pool_suspended");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("manually disabled accounts are skipped during selection, preparation, and health reset", async () => {
    await setAccountDisabled(getAccounts()[0].email, true);
    await resetAccount(getAccounts()[0].email);
    expect(await getBestAccount("sandbox", model)).toBeNull();
    expect(await getBestAccount()).toBeNull();
    expect(await prepareAccountForRequest(getAccounts()[0].email, true)).toBeNull();
    await setAccountDisabled(getAccounts()[0].email, false);
    expect(await prepareAccountForRequest(getAccounts()[0].email)).not.toBeNull();
    expect(getAccounts()[0].suspension).toBeUndefined();
  });

  test("disabling an account clears session bindings and overrides session affinity", async () => {
    const first = getAccounts()[0];
    recordSessionBinding({ identity: { key: "disabled-affinity", id: "disabled-affinity", source: "test", inferred: false },
      accountEmail: first.email, model, modelFamily: "Gemini Models", pool: "sandbox" });
    recordSessionBinding({ identity: { key: "disabled-affinity", id: "disabled-affinity", source: "test", inferred: false },
      accountEmail: first.email, model: "codex-test", modelFamily: "Codex", pool: "codex" });
    await setAccountDisabled(first.email, true);
    expect(getSessionBinding("disabled-affinity", model)).toBeNull();
    expect(getSessionBinding("disabled-affinity", "codex-test")?.accountEmail).toBe(first.email);
    const healthy = account("healthy-fallback@example.com");
    getAccounts().push(healthy);
    expect((await getBestAccount("sandbox", model, "disabled-affinity"))?.email).toBe(healthy.email);
  });

  test.each(["catalog", "summary", "activation"])("suspension during %s never disables the account", async stage => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(suspensionResponse());
    const first = getAccounts()[0];
    if (stage === "catalog") await fetchQuota(first);
    else if (stage === "summary") await fetchQuotaWindows(first);
    else await expect(activateGoogleGeminiWindow(first)).rejects.toThrow("403");
    expect(first.disabled).not.toBe(true);
    if (stage === 'activation') {
      expect(first.poolSuspensions?.['Gemini Models']?.reason).toBe('tos_violation');
      expect(saveSpy).toHaveBeenCalled();
    } else {
      expect(first.poolSuspensions).toBeUndefined();
    }
  });

  test.each([false, true])("switches from a suspended account to a healthy account (stream=%s)", async stream => {
    const first = getAccounts()[0];
    const healthy = account("healthy-fallback@example.com");
    healthy.lastUsed = Date.now();
    getAccounts().push(healthy);
    getProxyConfig().retry.maxAttempts = 2;
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(suspensionResponse())
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`));
    try {
      const execution = await executeCompletion({
        request: { model, messages: [{ role: "user", content: "OK" }], stream },
        sessionIdentity: { key: "suspension-fallback", id: "suspension-fallback", source: "test", inferred: false },
        requestId: "suspension-test", requestStartedAt: Date.now(),
      });
      const result = execution.kind === "stream" ? await collectCompletionStream(execution.stream)
        : execution.kind === "result" ? execution.result : null;
      expect(result?.text).toBe("OK");
      expect(first.disabled).not.toBe(true);
      expect(isAccountPoolSuspended(first, model)).toBe(true);
      expect(healthy.disabled).toBeUndefined();
      expect(getSessionBinding("suspension-fallback", model)?.accountEmail).toBe(healthy.email);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      deleteSessionBindingsForAccount(healthy.email);
    }
  });

  test("manually disabled accounts are not misreported as quota or verification failures", async () => {
    getAccounts()[0].disabled = true;
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    const result = await run();
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("accounts_disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([false, true])("Sonnet 5.5 quota failover ignores legacy endpoints and updates affinity (stream=%s)", async stream => {
    const sonnet = "antigravity-claude-sonnet-5-5";
    const first = getAccounts()[0]!;
    const healthy = account("sonnet-fallback@example.com");
    healthy.lastUsed = Date.now();
    for (const a of [first, healthy]) {
      a.availableModels = [{ id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" }];
    }
    getAccounts().push(healthy);
    for (const endpoint of [ANTIGRAVITY_STREAM_URL, "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"]) {
      const identity = { key: "sonnet-failover", id: "sonnet-failover", source: "test", inferred: false };
      recordSessionBinding({ identity, accountEmail: first.email, model: sonnet,
        modelFamily: "Claude Sonnet 5.5", pool: "sandbox", endpoint });
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const token = new Headers(init?.headers).get("Authorization");
        if (token === "Bearer access") return Response.json({ error: {
          code: 429, status: "RESOURCE_EXHAUSTED", message: "Individual quota reached.",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3856.218183766s" }],
        } }, { status: 429 });
        if (url !== ANTIGRAVITY_STREAM_URL) return Response.json({ error: {
          code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota).",
        } }, { status: 429 });
        return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`);
      }) as unknown as typeof fetch);
      healthy.accessToken = "healthy-access";
      try {
        const execution = await executeCompletion({
          request: { model: sonnet, messages: [{ role: "user", content: "OK" }], stream },
          sessionIdentity: identity, requestId: "sonnet-failover-test", requestStartedAt: Date.now(),
        });
        const result = execution.kind === "stream" ? await collectCompletionStream(execution.stream)
          : execution.kind === "result" ? execution.result : null;
        expect(result?.text).toBe("OK");
        expect(fetchSpy.mock.calls.map((call: Parameters<typeof fetch>) => call[0])).toEqual([ANTIGRAVITY_STREAM_URL, ANTIGRAVITY_STREAM_URL]);
        expect(getSessionBinding(identity.key, sonnet)).toMatchObject({ accountEmail: healthy.email, endpoint: ANTIGRAVITY_STREAM_URL });
        expect(healthy.cooldowns?.["sandbox|Claude Sonnet 5.5"]).toBeUndefined();
      } finally {
        for (const a of [first, healthy]) {
          clearCooldown(a.email, "sandbox", "Claude Sonnet 5.5");
          deleteSessionBindingsForAccount(a.email);
        }
        fetchSpy.mockRestore();
        fetchSpy = undefined;
      }
    }
  });

  test("quota state and temporary cooldowns have distinct error codes", async () => {
    getAccounts()[0].quota = [{
      groupName: "Gemini Models", limit: "100", usage: "100", limitName: "gemini",
      remainingFraction: 0, quotaLeft: "0%", resetIn: "1h",
    }];
    expect(getAccountSelectionFailure("sandbox", model)).toBe("insufficient_quota");
    getAccounts()[0].quota = [];
    markCooldown(getAccounts()[0].email, "sandbox", "Gemini Models", "60s");
    const result = await run();
    expect(result.status).toBe(429);
    expect(result.body.error).toMatchObject({ type: "rate_limit_error", code: "rate_limit_exceeded" });
  });

  test.each(["server", "network"])("rotates accounts after a %s failure and quota exhaustion using only the default endpoint", async failure => {
    const second = account("endpoint-second@example.com");
    const third = account("endpoint-third@example.com");
    second.accessToken = "second-access";
    third.accessToken = "third-access";
    second.projectId = "second-project";
    third.projectId = "third-project";
    second.lastUsed = Date.now();
    third.lastUsed = second.lastUsed + 1;
    getAccounts().push(second, third);
    const identity = { key: "endpoint-failover", id: "endpoint-failover", source: "test", inferred: false };
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
    if (failure === "server") {
      fetchSpy.mockResolvedValueOnce(Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 }));
    } else {
      fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));
    }
    fetchSpy
      .mockResolvedValueOnce(Response.json({ error: { status: "RESOURCE_EXHAUSTED" } }, { status: 429 }))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`));
    try {
      const execution = await executeCompletion({
        request: { model, messages: [{ role: "user", content: "OK" }], stream: false },
        sessionIdentity: identity, requestId: "endpoint-failover-test", requestStartedAt: Date.now(),
      });
      expect(execution.kind).toBe("result");
      expect(fetchSpy.mock.calls.map((call: Parameters<typeof fetch>) => call[0])).toEqual(Array(3).fill(ANTIGRAVITY_STREAM_URL));
      expect(fetchSpy.mock.calls.map((call: Parameters<typeof fetch>) => new Headers(call[1]?.headers).get("Authorization")))
        .toEqual(["Bearer access", "Bearer second-access", "Bearer third-access"]);
      expect(fetchSpy.mock.calls.map((call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body)).project))
        .toEqual(getAccounts().map(a => a.projectId));
      expect(getSessionBinding(identity.key, model)).toMatchObject({ accountEmail: third.email, endpoint: ANTIGRAVITY_STREAM_URL });
    } finally {
      clearCooldown(second.email, "sandbox", "Gemini Models");
      for (const a of getAccounts()) deleteSessionBindingsForAccount(a.email);
    }
  });

  test("does not declare a model missing when a supporting account requires verification", () => {
    getAccounts()[0].capabilities = { [model]: false };
    const second = account("verification-test@example.com");
    second.challenge = { type: "CAPTCHA", url: "https://example.com", detectedAt: Date.now() };
    getAccounts().push(second);
    expect(getAccountSelectionFailure("sandbox", model)).toBe("account_verification_required");
  });

  test.each([
    [503, "unknown_error", 503, "upstream_error"],
    [502, "empty_response", 502, "upstream_error"],
    [429, "quota_exhausted", 429, "insufficient_quota"],
    [429, "unknown_error", 429, "rate_limit_exceeded"],
    [403, "validation_required", 403, "account_verification_required"],
  ])("preserves failure HTTP %s / %s", async (status, reason, expectedStatus, expectedCode) => {
    const result = buildCompletionFailure(model, "sandbox", 3, [{ email: "test@example.com", status, reason }]);
    if (result.kind !== "error") throw new Error("Expected completion failure");
    expect(result.response.status).toBe(expectedStatus);
    const body = await result.response.json() as any;
    expect(body.error.code).toBe(expectedCode);
    expect(body.error.attempts).toHaveLength(1);
  });

  test("an upstream outage reaching the retry limit is not reported as quota exhaustion", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { code: 503, status: "UNAVAILABLE", message: "Service unavailable" },
    }, { status: 503 }));
    const result = await run();
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("upstream_error");
    expect(result.body.error.message).toContain("503");
  });

  test.each(["complete", "cancel", "error"])("cleans up stream timers and abort listeners on %s", async ending => {
    const timeouts = getProxyConfig().models.timeouts;
    const originalStreamTimeout = timeouts.stream;
    timeouts.stream = 100;
    const client = new AbortController();
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelledWith: unknown;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] } }] })}\n\n`,
        ));
      },
      cancel(reason) { cancelledWith = reason; },
    });
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(source));
    let cancelReader: (() => Promise<void>) | undefined;
    try {
      const execution = await executeCompletion({
        request: { model, messages: [{ role: "user", content: "OK" }], stream: true },
        sessionIdentity: { key: "failure-regression", id: "failure-regression", source: "test", inferred: false },
        requestId: `stream-cleanup-${ending}`, requestStartedAt: Date.now(), signal: client.signal,
      });
      if (execution.kind !== "stream") throw new Error("Expected stream");
      const upstreamSignal = fetchSpy.mock.calls[0]![1]!.signal!;
      const reader = execution.stream.getReader();
      cancelReader = () => reader.cancel();
      expect((await reader.read()).done).toBe(false);
      if (ending === "complete") {
        sourceController.close();
        while (!(await reader.read()).done) {}
      } else if (ending === "cancel") {
        await reader.cancel("client stopped reading");
      } else {
        const failure = new Error("upstream disconnected");
        sourceController.error(failure);
        await expect(reader.read()).rejects.toBe(failure);
      }
      // A completed/cancelled/failed response must not fire its stream timeout.
      await Bun.sleep(125);
      expect(upstreamSignal.aborted).toBe(false);
      client.abort("late client abort");
      expect(upstreamSignal.aborted).toBe(false);
      if (ending === "cancel") expect(cancelledWith).toBe("client stopped reading");
    } finally {
      timeouts.stream = originalStreamTimeout;
      await cancelReader?.().catch(() => {});
    }
  });

  function genericInvalidArgument(details?: unknown[]) {
    return Response.json({
      error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument.", ...(details ? { details } : {}) },
    }, { status: 400 });
  }

  test("recovers a generic Gemini 400 on another account using the default endpoint", async () => {
    getProxyConfig().retry.maxAttempts = 3;
    const healthy = account("generic-400-fallback@example.com");
    healthy.accessToken = "healthy-access";
    healthy.lastUsed = Date.now();
    getAccounts().push(healthy);
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(genericInvalidArgument())
      .mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Recovered" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ));
    const execution = await executeCompletion({
      request: { model, messages: [{ role: "user", content: "OK" }], stream: true },
      sessionIdentity: { key: "failure-regression", id: "failure-regression", source: "test", inferred: false },
      requestId: "generic-400-recovery", requestStartedAt: Date.now(),
    });
    expect(execution.kind).toBe("stream");
    if (execution.kind !== "stream") throw new Error("Expected recovered stream");
    expect(execution.attempts).toBe(2);
    expect((await collectCompletionStream(execution.stream)).text).toBe("Recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [first, second] = fetchSpy.mock.calls;
    expect(second![0]).toBe(first![0]);
    // The envelope gets a new requestId, while model input remains identical.
    const firstBody = JSON.parse(String(first![1]?.body));
    const secondBody = JSON.parse(String(second![1]?.body));
    expect(secondBody.request.labels.cascade_id).toBe(firstBody.request.labels.cascade_id);
    expect(secondBody.request.labels.trajectory_id).not.toBe(firstBody.request.labels.trajectory_id);
    for (const body of [firstBody, secondBody]) {
      delete body.request.labels.trajectory_id;
      delete body.request.labels.request_id;
    }
    expect(secondBody.request).toEqual(firstBody.request);
    expect(secondBody.project).toBe(firstBody.project);
    expect(secondBody.model).toBe(firstBody.model);
    expect(new Headers(second![1]?.headers).get("Authorization")).toBe("Bearer healthy-access");
    deleteSessionBindingsForAccount(healthy.email);
  });

  test("retries a persistent generic Gemini 400 only once and preserves the error", async () => {
    getProxyConfig().retry.maxAttempts = 5;
    getAccounts().push(account("generic-400-second@example.com"));
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(genericInvalidArgument([]))
      .mockResolvedValueOnce(genericInvalidArgument([]));
    const result = await run();
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("invalid_argument");
    expect(result.body.error.attempts).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getAccounts()[0].healthScore).toBe(100);
    expect(getAccounts()[0].capabilities?.[model]).toBeUndefined();
  });

  test("does not retry detailed validation failures", async () => {
    getProxyConfig().retry.maxAttempts = 5;
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(genericInvalidArgument([
      { "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations: [{ field: "contents", description: "Invalid input" }] },
    ]));
    expect((await run()).status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("does not retry explicit parameter errors", async () => {
    getProxyConfig().retry.maxAttempts = 5;
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      error: { code: 400, status: "INVALID_ARGUMENT", message: "temperature must be non-negative" },
    }, { status: 400 }));
    const result = await run();
    expect(result.body.error.message).toBe("temperature must be non-negative");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("respects a single-attempt budget for generic Gemini 400 failures", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(genericInvalidArgument());
    expect((await run()).status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
