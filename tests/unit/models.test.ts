import { describe, expect, test } from "bun:test";
import { SUPPORTED_MODELS } from "../../src/models";

describe("supported model catalog", () => {
  test("exposes the current Antigravity model list", () => {
    expect(SUPPORTED_MODELS).toEqual([
      { id: "antigravity-gemini-3.8-flash", name: "Gemini 3.8 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" },
      { id: "antigravity-gemini-3.7-flash", name: "Gemini 3.7 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" },
      { id: "antigravity-gemini-3.6-flash", name: "Gemini 3.6 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" },
      { id: "antigravity-gemini-3.5-flash", name: "Gemini 3.5 Flash", thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" },
      { id: "antigravity-gemini-3.1-pro", name: "Gemini 3.1 Pro", thinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
      { id: "antigravity-claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
      { id: "antigravity-claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", thinkingLevels: ["thinking"], defaultThinkingLevel: "thinking" },
      { id: "antigravity-gpt-oss-120b", name: "GPT-OSS 120B", thinkingLevels: ["medium"], defaultThinkingLevel: "medium" }
    ]);
  });
});
