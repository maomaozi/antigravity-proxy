import { describe, expect, test } from "bun:test";
import { CodexDeviceAuthService } from "../../src/codex/device-auth";

describe("Codex device-code login", () => {
  test("exposes only browser-safe device login state and persists tokens after authorization", async () => {
    const calls: string[] = [];
    const saved: any[] = [];
    let tokenPolls = 0;
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return Response.json({ device_auth_id: "secret-device-id", user_code: "ABCD-EFGH", interval: "0" });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        tokenPolls++;
        return Response.json({
          authorization_code: "authorization-code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        });
      }
      if (url.endsWith("/oauth/token")) {
        const payload = Buffer.from(JSON.stringify({
          email: "codex@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
        })).toString("base64url");
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          id_token: `x.${payload}.x`,
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const service = new CodexDeviceAuthService({
      fetchImpl: fakeFetch as unknown as typeof fetch,
      sleep: async () => {},
      onCredentials: async credentials => { saved.push(credentials); },
    });

    const started = await service.start();
    expect(started.status).toBe("waiting");
    expect(started.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(started)).not.toContain("secret-device-id");

    await service.waitForCompletion(started.loginId);
    const completed = service.get(started.loginId);
    expect(completed?.status).toBe("completed");
    expect(completed?.email).toBe("codex@example.com");
    expect(saved[0]).toMatchObject({
      email: "codex@example.com",
      accountId: "acct_123",
      accessToken: "access",
      refreshToken: "refresh",
    });
    expect(tokenPolls).toBe(1);
    expect(calls).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
  });

  test("reports unsupported device-code start without leaking upstream response", async () => {
    const service = new CodexDeviceAuthService({
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(service.start()).rejects.toThrow("device code login is not enabled");
  });
});
