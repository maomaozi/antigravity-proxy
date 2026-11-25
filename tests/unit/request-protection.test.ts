import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCompletion } from "../../src/api/completion-executor";
import {
  evaluateAccountModelQuotaState,
  fetchQuota,
  fetchQuotaWindows,
  refreshAccountQuotaSingleFlight,
} from "../../src/api/quota";
import { getGoogleActivationTargets, runQuotaWindowActivationCheck } from "../../src/api/window-activation";
import {
  beginAccountTosRecovery,
  clearCooldown,
  completeAccountTosRecovery,
  getAccounts,
  getBestAccount,
  suspendAccountPool,
  verifyAndRecoverTosAccount,
} from "../../src/auth/manager";
import { GoogleAccountStorage } from "../../src/auth/storage";
import * as storage from "../../src/auth/storage";
import type { AntigravityAccount } from "../../src/auth/types";
import { getProxyConfig, loadProxyConfig } from "../../src/config/manager";
import { collectCompletionStream } from "../../src/core/completion";
import { getAvailableModelCatalog, isAccountPoolSuspended } from "../../src/models";
import { resolveSessionIdentity } from "../../src/session/identity";
import {
  deleteSessionBindingsForAccount,
  getSessionBinding,
  getSessionRoutingGuard,
  SessionBindingStore,
} from "../../src/session/store";
import { parseGoogleError } from "../../src/utils/errors";

describe("codex -> antigravity request protection", () => {
  const model = "antigravity-gemini-3.8-flash";
  let originalAccounts: AntigravityAccount[];
  let saveSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let originalMaxAttempts: number;
  let originalJitter: boolean;
  const tempDirs: string[] = [];

  function makeAccount(email: string, accessToken: string, lastUsed = 0): AntigravityAccount {
    return {
      email,
      refreshToken: `refresh-${email}`,
      accessToken,
      expiresAt: Date.now() + 3600_000,
      projectId: `project-${email}`,
      healthScore: 100,
      lastUsed,
      tokenUsage: 0,
      availableModels: [{ id: "gemini-3.8-flash-tiered", name: "Gemini 3.8 Flash", supportsThinking: true }],
      quotaUpdatedAt: Date.now(),
      quotaWindowsUpdatedAt: Date.now(),
      quota: [{
        groupName: "Gemini 3.8 Flash",
        limit: "100",
        usage: "10",
        limitName: "gemini",
        remainingFraction: 0.9,
        quotaLeft: "90%",
        resetIn: "4h",
        modelId: "gemini-3.8-flash-tiered",
        modelIds: ["gemini-3.8-flash-tiered"],
      }],
      quotaWindows: [
        { groupName: "Gemini Models", window: "5h", remainingFraction: 0.9 },
        { groupName: "Gemini Models", window: "weekly", remainingFraction: 0.9 },
      ],
    };
  }

  beforeEach(async () => {
    await loadProxyConfig();
    originalAccounts = [...getAccounts()];
    const a = makeAccount("prot-a@example.com", "access-a", 1000);
    const b = makeAccount("prot-b@example.com", "access-b", 2000);
    const c = makeAccount("prot-c@example.com", "access-c", 3000);
    getAccounts().splice(0, getAccounts().length, a, b, c);
    saveSpy = spyOn(storage, "saveConfig").mockResolvedValue(undefined);
    const config = getProxyConfig();
    originalMaxAttempts = config.retry.maxAttempts;
    originalJitter = config.features.jitterEnabled;
    config.retry.maxAttempts = 5;
    config.features.jitterEnabled = false;
  });

  afterEach(async () => {
    for (const email of ["prot-a@example.com", "prot-b@example.com", "prot-c@example.com"]) {
      clearCooldown(email, "sandbox", "Gemini Models");
      deleteSessionBindingsForAccount(email);
    }
    getAccounts().splice(0, getAccounts().length, ...originalAccounts);
    getProxyConfig().retry.maxAttempts = originalMaxAttempts;
    getProxyConfig().features.jitterEnabled = originalJitter;
    saveSpy.mockRestore();
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    while (tempDirs.length) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test("error classification distinguishes explicit quota exhaustion, rate limit, generic 429, and TOS", () => {
    const explicit = parseGoogleError(JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Individual quota reached.",
        details: [{ reason: "QUOTA_EXHAUSTED", retryDelay: "120s" }],
      },
    }));
    expect(explicit.isExplicitQuotaExhausted).toBe(true);
    expect(explicit.isRateLimited).toBe(false);
    expect(explicit.isAmbiguous429).toBe(false);

    const generic = parseGoogleError(JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Resource has been exhausted (e.g. check quota).",
      },
    }));
    expect(generic.isExplicitQuotaExhausted).toBe(false);
    expect(generic.isAmbiguous429).toBe(true);

    const rateLimit = parseGoogleError(JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Rate limit exceeded",
        details: [{ reason: "RATE_LIMIT_EXCEEDED" }],
      },
    }));
    expect(rateLimit.isExplicitQuotaExhausted).toBe(false);
    expect(rateLimit.isRateLimited).toBe(true);

    const tos = parseGoogleError(JSON.stringify({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "This service has been disabled in this account for violation of Terms of Service.",
        details: [{ reason: "TOS_VIOLATION", metadata: { appeal_url: "https://forms.gle/appeal" } }],
      },
    }));
    expect(tos.isTosViolation).toBe(true);
    expect(tos.isServiceSuspended).toBe(true);
    expect(tos.appealUrl).toBe("https://forms.gle/appeal");
  });

  test("quota freshness checks quotaUpdatedAt and quotaWindowsUpdatedAt independently", () => {
    const now = Date.now();
    const acc = makeAccount("fresh@example.com", "access-fresh");
    acc.quotaUpdatedAt = now - 10_000;
    acc.quotaWindowsUpdatedAt = now - 90_000; // stale > 60s
    const staleWindowEval = evaluateAccountModelQuotaState(acc, "gemini-3.8-flash-tiered", undefined, now);
    expect(staleWindowEval.quotaFresh).toBe(true);
    expect(staleWindowEval.windowsFresh).toBe(false);
    expect(staleWindowEval.obviouslySufficient).toBe(false);
    expect(staleWindowEval.needsRefresh).toBe(true);

    acc.quotaWindowsUpdatedAt = now - 10_000;
    const freshEval = evaluateAccountModelQuotaState(acc, "gemini-3.8-flash-tiered", undefined, now);
    expect(freshEval.obviouslySufficient).toBe(true);
    expect(freshEval.needsRefresh).toBe(false);

    acc.quotaWindows![0]!.remainingFraction = 0.04; // <= 5%
    const lowEval = evaluateAccountModelQuotaState(acc, "gemini-3.8-flash-tiered", undefined, now);
    expect(lowEval.obviouslySufficient).toBe(false);
  });

  test("pins account A before upstream request is sent and does not mark failed attempts as success", async () => {
    let guardDuringFetch: ReturnType<typeof getSessionRoutingGuard> = null;
    const identity = resolveSessionIdentity(new Headers({ "x-session-id": "pin-before-send" }), {});

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      guardDuringFetch = getSessionRoutingGuard(identity.key, model);
      return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
    }) as unknown as typeof fetch);

    getProxyConfig().retry.maxAttempts = 1;
    const result = await executeCompletion({
      request: { model, messages: [{ role: "user", content: "hi" }], stream: false },
      sessionIdentity: identity,
      requestId: "req-pin",
      requestStartedAt: Date.now(),
    });

    expect(result.kind).toBe("error");
    expect(guardDuringFetch).not.toBeNull();
    expect(guardDuringFetch!.accountEmail).toBe("prot-a@example.com");
    expect(guardDuringFetch!.status).toBe("pinned");
    expect(getSessionBinding(identity.key, model)).toBeNull();
  });

  test("stops rotation on 429 when quota >5% and fresh, protects outer retry, and probes only A after retryAt", async () => {
    const identity = resolveSessionIdentity(new Headers({ "x-session-id": "guard-429-sufficient" }), {});
    const req = { model, messages: [{ role: "user", content: "hello" }], stream: false };
    const calls: string[] = [];

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") || "";
      calls.push(auth);
      return Response.json({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Rate limit reached",
          details: [{ reason: "RATE_LIMIT_EXCEEDED" }],
        },
      }, { status: 429 });
    }) as unknown as typeof fetch);

    // 1. Initial request hits 429 on A while A has 90% fresh quota -> stops without touching B.
    const first = await executeCompletion({
      request: req,
      sessionIdentity: identity,
      requestId: "req-429-1",
      requestStartedAt: Date.now(),
    });
    expect(first.kind).toBe("error");
    if (first.kind === "error") {
      expect(first.response.status).toBe(429);
      const body = await first.response.json() as any;
      expect(body.error.code).toBe("upstream_429_with_quota");
      expect(Number(first.response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(60);
    }
    expect(calls).toEqual(["Bearer access-a"]);
    expect(getAccounts()[0]!.healthScore).toBe(100);
    expect(getAccounts()[0]!.quota?.[0]?.remainingFraction).toBe(0.9);

    // 2. Outer HTTP retry during retryAt wait window returns same 429 without calling upstream or touching B.
    const outerRetry = await executeCompletion({
      request: req,
      sessionIdentity: identity,
      requestId: "req-429-2",
      requestStartedAt: Date.now(),
    });
    expect(outerRetry.kind).toBe("error");
    if (outerRetry.kind === "error") {
      expect(outerRetry.response.status).toBe(429);
      expect((await outerRetry.response.json() as any).error.code).toBe("upstream_429_with_quota");
    }
    expect(calls).toEqual(["Bearer access-a"]);

    // 3. New message in same session during wait window also stays pinned and does not switch to B.
    const followUp = await executeCompletion({
      request: { model, messages: [{ role: "user", content: "different prompt" }], stream: false },
      sessionIdentity: identity,
      requestId: "req-429-3",
      requestStartedAt: Date.now(),
    });
    expect(followUp.kind).toBe("error");
    expect(calls).toEqual(["Bearer access-a"]);

    // 4. After retryAt expires, concurrent requests allow only ONE probe on A (never B), and success clears 429 protection.
    const db = new SessionBindingStore(process.env.SESSION_DB_FILE || join(process.cwd(), "data", "session-bindings.sqlite"));
    db.upsertRoutingGuard({
      sessionScopeKey: identity.key,
      model,
      accountEmail: "prot-a@example.com",
      status: "protected_429",
      reason: "upstream_429_with_quota",
      errorCode: "upstream_429_with_quota",
      retryAt: Date.now() - 10,
      probeInProgress: false,
      attemptsUsed: 1,
      accountAttemptsUsed: 1,
      accountsTouched: ["prot-a@example.com"],
    });
    db.close();

    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("Authorization") || "");
      await Bun.sleep(25);
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Recovered on A" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch);

    const [probeRes, concurrentRes] = await Promise.all([
      executeCompletion({ request: req, sessionIdentity: identity, requestId: "probe-1", requestStartedAt: Date.now() }),
      executeCompletion({ request: req, sessionIdentity: identity, requestId: "probe-2", requestStartedAt: Date.now() }),
    ]);

    const kinds = [probeRes.kind, concurrentRes.kind].sort();
    expect(kinds).toEqual(["error", "result"]);
    expect(calls).toEqual(["Bearer access-a", "Bearer access-a"]);
    expect(getSessionRoutingGuard(identity.key, model)?.status).toBe("pinned");
  });

  test("stale/conflicting quota triggers single-flight refresh and does not mis-rotate when incomplete or conflicting", async () => {
    const a = getAccounts()[0]!;
    a.quotaUpdatedAt = Date.now() - 120_000; // stale (>60s)
    let refreshFetches = 0;
    const identity = resolveSessionIdentity(new Headers({ "x-session-id": "conflict-429" }), {});

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: any) => {
      const u = String(url);
      if (u.includes("fetchAvailableModels")) {
        refreshFetches++;
        return Response.json({
          models: {
            "gemini-3.8-flash-tiered": { displayName: "Gemini 3.8 Flash", quotaInfo: { remainingFraction: 0.85, resetTime: "3600s" } },
          },
        });
      }
      if (u.includes("retrieveUserQuotaSummary")) {
        refreshFetches++;
        return Response.json({
          groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.85 }] }],
        });
      }
      return Response.json({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exhausted",
          details: [{ reason: "QUOTA_EXHAUSTED", retryDelay: "75s" }],
        },
      }, { status: 429 });
    }) as unknown as typeof fetch);

    // Concurrent single-flight refresh deduplication check
    await Promise.all([
      refreshAccountQuotaSingleFlight(a),
      refreshAccountQuotaSingleFlight(a),
    ]);
    expect(refreshFetches).toBe(2); // 1 fetchAvailableModels + 1 retrieveUserQuotaSummary

    // Make stale again, then execute completion -> refreshes once, sees 85% (>5%) conflict -> stops without rotating to B.
    a.quotaUpdatedAt = Date.now() - 120_000;
    const res = await executeCompletion({
      request: { model, messages: [{ role: "user", content: "hi" }], stream: false },
      sessionIdentity: identity,
      requestId: "req-conflict",
      requestStartedAt: Date.now(),
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.response.status).toBe(429);
      expect((await res.response.json() as any).error.code).toBe("upstream_429_with_quota");
    }
    expect(getSessionRoutingGuard(identity.key, model)?.reason).toBe("quota_evidence_conflict");
  });

  test("ordinary errors try A up to 3 times, then B, max 2 accounts, respecting strict maxAttempts and outer retries", async () => {
    const req = { model, messages: [{ role: "user", content: "retry test" }], stream: false };
    const headers = new Headers({ "user-agent": "codex-cli/0.169.0" });
    // No explicit session ID -> fallback to payload digest isolated by caller scope!
    const identity1 = resolveSessionIdentity(headers, {});
    const identity2 = resolveSessionIdentity(headers, {});
    expect(identity1.source).toBe("generated");

    const calls: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("Authorization") || "");
      return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
    }) as unknown as typeof fetch);

    getProxyConfig().retry.maxAttempts = 5;
    const firstAttempt = await executeCompletion({
      request: req,
      sessionIdentity: identity1,
      requestId: "ordinary-1",
      requestStartedAt: Date.now(),
    });
    expect(firstAttempt.kind).toBe("error");
    // 3 times on A + 2 times on B = 5 total (never touches C)
    expect(calls).toEqual([
      "Bearer access-a",
      "Bearer access-a",
      "Bearer access-a",
      "Bearer access-b",
      "Bearer access-b",
    ]);

    // Outer retry with same payload & caller scope returns retained error immediately without touching A/B/C.
    const outerRetry = await executeCompletion({
      request: req,
      sessionIdentity: identity2,
      requestId: "ordinary-2",
      requestStartedAt: Date.now(),
    });
    expect(outerRetry.kind).toBe("error");
    expect(calls).toHaveLength(5);

    // Budget < 3 (e.g. maxAttempts = 2) must not break budget to switch to B.
    const lowBudgetCalls: string[] = [];
    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init?: RequestInit) => {
      lowBudgetCalls.push(new Headers(init?.headers).get("Authorization") || "");
      return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
    }) as unknown as typeof fetch);
    getProxyConfig().retry.maxAttempts = 2;
    const lowBudgetId = resolveSessionIdentity(new Headers({ "x-session-id": "low-budget" }), {});
    await executeCompletion({
      request: req,
      sessionIdentity: lowBudgetId,
      requestId: "low-budget-req",
      requestStartedAt: Date.now(),
    });
    expect(lowBudgetCalls).toHaveLength(2);
    expect(new Set(lowBudgetCalls).size).toBe(1);
  }, 15_000);

  test("401 refreshes token once on A and retries once on A only", async () => {
    const identity = resolveSessionIdentity(new Headers({ "x-session-id": "auth-401" }), {});
    const calls: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com")) {
        return Response.json({ access_token: "refreshed-a", expires_in: 3600 });
      }
      calls.push(new Headers(init?.headers).get("Authorization") || "");
      if (calls.length === 1) {
        return Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 });
      }
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch);

    const execution = await executeCompletion({
      request: { model, messages: [{ role: "user", content: "hi" }], stream: false },
      sessionIdentity: identity,
      requestId: "req-401",
      requestStartedAt: Date.now(),
    });
    expect(execution.kind).toBe("result");
    expect(calls).toEqual(["Bearer access-a", "Bearer refreshed-a"]);
  });

  test("TOS isolation persists by pool and verified recovery clears only that pool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tos-persist-"));
    tempDirs.push(dir);
    const accountsPath = join(dir, "accounts.json");

    const identityA = resolveSessionIdentity(new Headers({ "x-session-id": "tos-session-a" }), {});
    const identityB = resolveSessionIdentity(new Headers({ "x-session-id": "other-session-b" }), {});
    const req = { model, messages: [{ role: "user", content: "hello" }], stream: false };

    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === "Bearer access-a") {
        return Response.json({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "This service has been disabled in this account for violation of Terms of Service.",
            details: [{ reason: "TOS_VIOLATION", metadata: { appeal_url: "https://forms.gle/appeal" } }],
          },
        }, { status: 403 });
      }
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "B OK" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch);

    // 1. Account A receives TOS_VIOLATION -> 403, stops rotation, B is NOT touched for identityA.
    const resA = await executeCompletion({
      request: req,
      sessionIdentity: identityA,
      requestId: "tos-a-1",
      requestStartedAt: Date.now(),
    });
    expect(resA.kind).toBe("error");
    if (resA.kind === "error") {
      expect(resA.response.status).toBe(403);
      expect((await resA.response.json() as any).error.appeal_url).toBe("https://forms.gle/appeal");
    }

    const a = getAccounts()[0]!;
    expect(isAccountPoolSuspended(a, model)).toBe(true);
    expect(a.disabled).not.toBe(true);
    expect(getSessionRoutingGuard(identityA.key, model)?.status).toBe("terminated_tos");

    // 2. Simulate persistence reload across restart.
    const fileStorage = new GoogleAccountStorage(accountsPath);
    await fileStorage.save({ accounts: [a] });
    const reloaded = await new GoogleAccountStorage(accountsPath).load();
    expect(isAccountPoolSuspended(reloaded.accounts[0]!, model)).toBe(true);
    expect(reloaded.accounts[0]!.poolSuspensions?.["Gemini Models"]?.status).toBe("suspended");

    // 3. Quota collection can still contact the account. Activation skips the blocked pool.
    const quotaRequests: string[] = [];
    const quotaFetch = (async (url: Parameters<typeof fetch>[0]) => {
      quotaRequests.push(String(url));
      return new Response(null, { status: 500 });
    }) as typeof fetch;
    await fetchQuota(a, true, quotaFetch);
    await fetchQuotaWindows(a, quotaFetch);
    expect(quotaRequests).toHaveLength(2);
    a.availableModels!.push({ id: "gemini-4-custom-high", name: "Gemini 4 Custom" });
    expect(getAvailableModelCatalog([a]).some(m => m.id.includes("custom"))).toBe(true);
    expect(getGoogleActivationTargets(a)).toEqual([]);
    const activationSummary = await runQuotaWindowActivationCheck({
      refreshGoogleQuotas: async () => {},
      listGoogleAccounts: () => [a],
      getCodexUsageSnapshots: async () => [],
      activateGoogle: async () => { throw new Error("Should never activate TOS account"); },
      activateCodex: async () => true,
      refreshCodexUsage: async () => {},
    });
    expect(activationSummary.googleActivated).toBe(0);

    // 4. Other account B remains completely usable for its own session!
    const resB = await executeCompletion({
      request: req,
      sessionIdentity: identityB,
      requestId: "ok-b-1",
      requestStartedAt: Date.now(),
    });
    expect(resB.kind).toBe("result");
    if (resB.kind === "result") {
      expect(resB.result.text).toBe("B OK");
    }

    // 5. Controlled manual recovery keeps isolation if verification fails, clears only if verification succeeds.
    await suspendAccountPool(a.email, "claude-sonnet-4-6", { reason: "tos_violation" });
    expect(await beginAccountTosRecovery(a.email, model)).toBe(true);
    expect(await getBestAccount("sandbox", model)).not.toEqual(expect.objectContaining({ email: a.email }));
    expect(await completeAccountTosRecovery(a.email, false)).toBe(false);
    expect(isAccountPoolSuspended(a, model)).toBe(true);

    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    expect(await verifyAndRecoverTosAccount(a.email, { model })).toBe(true);
    expect(isAccountPoolSuspended(a, model)).toBe(false);
    expect(isAccountPoolSuspended(a, "claude-sonnet-4-6")).toBe(true);
    expect(getSessionRoutingGuard(identityA.key, model)).toBeNull();
  });

  test("stream output starts cleanly and client abort does not retry", async () => {
    const identity = resolveSessionIdentity(new Headers({ "x-session-id": "stream-abort" }), {});
    const abortController = new AbortController();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      abortController.abort("client cancelled");
      throw new DOMException("Aborted", "AbortError");
    }) as unknown as typeof fetch);

    await expect(executeCompletion({
      request: { model, messages: [{ role: "user", content: "hi" }], stream: true },
      sessionIdentity: identity,
      requestId: "req-abort",
      requestStartedAt: Date.now(),
      signal: abortController.signal,
    })).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Stream success clears any prior attempt counter while keeping affinity
    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Stream OK" }] }, finishReason: "STOP" }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    const streamExec = await executeCompletion({
      request: { model, messages: [{ role: "user", content: "hi" }], stream: true },
      sessionIdentity: identity,
      requestId: "req-stream-ok",
      requestStartedAt: Date.now(),
    });
    expect(streamExec.kind).toBe("stream");
    if (streamExec.kind === "stream") {
      expect((await collectCompletionStream(streamExec.stream)).text).toBe("Stream OK");
    }
  });
});
