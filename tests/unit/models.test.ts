import { describe, expect, test } from "bun:test";
import { SUPPORTED_MODELS, getUnavailableModelError } from "../../src/models";

describe("supported model catalog", () => {
  test("exposes the current Antigravity model list", () => {
    expect(SUPPORTED_MODELS.map(({ description, recommended, ...model }) => model)).toEqual([
      { id: "antigravity-gemini-3.8-flash", name: "Gemini 3.8 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "high" },
      { id: "antigravity-gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
      { id: "antigravity-gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
      { id: "antigravity-gemini-3-flash", name: "Gemini 3 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "low" },
      { id: "antigravity-claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
      { id: "antigravity-claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
      { id: "antigravity-gpt-oss-120b", name: "GPT-OSS 120B", thinkingLevels: ["medium"], defaultThinkingLevel: "medium" }
    ]);
  });
  test.each(["antigravity-gemini-3.5-flash", "gemini-3.5-flash-low", "gemini-3.5-flash-extra-low", "openai/antigravity-gemini-3.5-flash-high", "gemini-3-flash-agent"])("rejects retired model %s with a replacement", model => {
    expect(getUnavailableModelError(model)).toContain("retired");
    expect(getUnavailableModelError(model)).toContain("antigravity-gemini-3.8-flash");
  });
  test.each(["antigravity-gemini-3.5-flash-lite", "gemini-3.5-flash-lite-high", "antigravity/gemini-3.1-flash-lite", "gemini-3-flash", "gemini-2.5-pro"])("keeps available Lite models and transient capacity failures separate from retirement: %s", model => {
    expect(getUnavailableModelError(model)).toBeUndefined();
  });

});
