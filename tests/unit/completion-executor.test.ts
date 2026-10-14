import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { buildCompletionFailure, executeCompletion, isExplicitAntigravityModel, resolveTimeouts } from "../../src/api/completion-executor";
import { getAccounts, getAccountSelectionFailure, markCooldown, clearCooldown } from "../../src/auth/manager";
import type { AntigravityAccount } from "../../src/auth/types";
import * as storage from "../../src/auth/storage";
import { getProxyConfig } from "../../src/config/manager";

describe("completion executor pool routing", () => {
  test("recognizes explicit Antigravity model IDs as sandbox-only candidates", () => {
    expect(isExplicitAntigravityModel("antigravity-gemini-3.8-flash")).toBe(true);
    expect(isExplicitAntigravityModel("antigravity/gemini-3.8-flash")).toBe(true);
    expect(isExplicitAntigravityModel("openai/antigravity-gemini-3.8-flash")).toBe(true);
  });

  test("does not classify unprefixed Gemini models as explicit Antigravity models", () => {
    expect(isExplicitAntigravityModel("gemini-3.8-flash")).toBe(false);
    expect(isExplicitAntigravityModel("gemini-3.1-pro-preview")).toBe(false);
  });
});

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
});
