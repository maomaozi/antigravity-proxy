import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_CLIENT_VERSION } from "../../src/models";
import { generateFingerprint, getImpersonationHeaders, getAntigravityNativeHeaders } from "../../src/utils/headers";

describe("Antigravity Hub request headers", () => {
  test("matches the official 2.29.0 Linux ARM discovery request without legacy IDE headers", () => {
    expect(getAntigravityNativeHeaders("test-token")).toEqual({
      "Authorization": "Bearer test-token",
      "Content-Type": "application/json",
      "User-Agent": "antigravity/hub/2.29.0 (aidev_client; os_type=linux; arch=arm64; cl=1013064288)",
    });
  });
  test.each(["darwin/arm64", "darwin/x64"])("updates persisted client versions while preserving device identity on %s", platform => {
    const fingerprint = {
      ...generateFingerprint("test@example.com"),
      platform,
      userAgent: "antigravity/2.9.1 darwin/arm64",
    };
    const headers = getImpersonationHeaders("test-token", fingerprint, "claude-sonnet-4-6");
    expect(headers["User-Agent"]).toBe(`antigravity/hub/${ANTIGRAVITY_CLIENT_VERSION} ${platform}`);
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["X-Client-Device-Id"]).toBe(fingerprint.deviceId);
    expect(headers["X-Goog-QuotaUser"]).toBe(fingerprint.quotaUser);
    expect(headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");
  });
});
