import { describe, expect, test } from "bun:test";
import { isExplicitAntigravityModel, resolveTimeouts } from "../../src/api/completion-executor";

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
