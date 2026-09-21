import { describe, expect, test } from "bun:test";
import { isExplicitAntigravityModel } from "../../src/api/completion-executor";

describe("completion executor pool routing", () => {
  test("recognizes explicit Antigravity model IDs as sandbox-only candidates", () => {
    expect(isExplicitAntigravityModel("antigravity-gemini-3.7-flash")).toBe(true);
    expect(isExplicitAntigravityModel("antigravity/gemini-3.7-flash")).toBe(true);
    expect(isExplicitAntigravityModel("openai/antigravity-gemini-3.7-flash")).toBe(true);
  });

  test("does not classify unprefixed Gemini models as explicit Antigravity models", () => {
    expect(isExplicitAntigravityModel("gemini-3.7-flash")).toBe(false);
    expect(isExplicitAntigravityModel("gemini-3.1-pro-preview")).toBe(false);
  });
});
