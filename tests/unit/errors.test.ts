import { describe, expect, test } from "bun:test";
import { parseGoogleError } from "../../src/utils/errors";

describe("parseGoogleError", () => {
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
