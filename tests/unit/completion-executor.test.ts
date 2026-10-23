import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { buildCompletionFailure, executeCompletion, resolveTimeouts } from "../../src/api/completion-executor";
import { getAccounts, getAccountSelectionFailure, markCooldown, clearCooldown } from "../../src/auth/manager";
import { collectCompletionStream } from "../../src/core/completion";
import { ANTIGRAVITY_CLIENT_VERSION } from "../../src/models";
import { deleteSessionBindingsForAccount, getSessionBinding } from "../../src/session/store";
import type { AntigravityAccount } from "../../src/auth/types";
import * as storage from "../../src/auth/storage";
import { getProxyConfig } from "../../src/config/manager";

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
      expect(url).toBe(getProxyConfig().endpoints.sandbox[0]!);
      expect(JSON.parse(String(init?.body))).toMatchObject({ project: "project", model: upstreamModel });
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer access");
      expect(headers.get("User-Agent")).toStartWith(`antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} `);
      expect(headers.get("anthropic-beta")).toBe(model.includes("claude") ? "interleaved-thinking-2025-05-14" : null);
    }
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

  test("recovers a generic Gemini 400 on the same account, endpoint, and payload", async () => {
    getProxyConfig().retry.maxAttempts = 3;
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
    expect(secondBody.request).toEqual(firstBody.request);
    expect(secondBody.project).toBe(firstBody.project);
    expect(secondBody.model).toBe(firstBody.model);
    expect(new Headers(second![1]?.headers).get("Authorization")).toBe("Bearer access");
  });

  test("retries a persistent generic Gemini 400 only once and preserves the error", async () => {
    getProxyConfig().retry.maxAttempts = 5;
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
