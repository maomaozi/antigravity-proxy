import { expect, test, describe } from "bun:test";
import { getFamilyName } from "../../src/auth/manager";

describe("Manager Utils", () => {
  test("getFamilyName should correctly classify models", () => {
    expect(getFamilyName("gemini-3.7-flash-tiered")).toBe("Gemini Models");
    expect(getFamilyName("gemini-3.6-flash-medium")).toBe("Gemini Models");
    expect(getFamilyName("gemini-3.5-flash-low")).toBe("Gemini Models");
    expect(getFamilyName("gemini-3.1-pro-high")).toBe("Gemini Models");
    expect(getFamilyName("claude-sonnet-4-6-thinking")).toBe("Claude Sonnet 4.6");
    expect(getFamilyName("claude-opus-4-6-thinking")).toBe("Claude Opus 4.6");
    expect(getFamilyName("gpt-oss-120b-medium")).toBe("GPT-OSS 120B");
    expect(getFamilyName("unknown-model")).toBe("Other");
  });
});
