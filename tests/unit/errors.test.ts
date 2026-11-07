import { describe, expect, test } from "bun:test";
import { parseGoogleError } from "../../src/utils/errors";

describe("parseGoogleError", () => {
  test.each(["direct", "nested", "message"])("recognizes account suspension from %s evidence", kind => {
    const result = parseGoogleError(JSON.stringify({ error: {
      code: 403, status: "PERMISSION_DENIED",
      message: kind === "message"
        ? "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product."
        : "Service unavailable; quota not supported.",
      details: kind === "message" ? [] : [{
        ...(kind === "nested" ? { errorInfo: { reason: "TOS_VIOLATION" } } : { reason: "TOS_VIOLATION" }),
        metadata: { appeal_url: "https://forms.gle/appeal" },
      }],
    } }));
    expect(result).toMatchObject({ reason: "tos_violation", status: 403, isAccountSuspended: true,
      isChallengeRequired: false, isQuotaExhausted: false, isModelUnsupported: false });
    if (kind !== "message") expect(result.appealUrl).toBe("https://forms.gle/appeal");
  });

  test.each([
    { code: 403, status: "PERMISSION_DENIED", message: "Permission denied" },
    { code: 403, status: "PERMISSION_DENIED", message: "VALIDATION_REQUIRED" },
    { code: 403, status: "PERMISSION_DENIED", message: "Gemini Code Assist license required" },
    { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exhausted" },
  ])("does not treat ordinary access or quota errors as suspension: %j", error => {
    expect(parseGoogleError(JSON.stringify({ error })).isAccountSuspended).toBe(false);
  });

  test("classifies INVALID_ARGUMENT responses", () => {
    const result = parseGoogleError(JSON.stringify({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT"
      }
    }));

    expect(result.reason).toBe("invalid_argument");
    expect(result.status).toBe(400);
    expect(result.message).toBe("Request contains an invalid argument.");
    expect(result.isQuotaExhausted).toBe(false);
  });
});
