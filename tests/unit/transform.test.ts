
import { beforeAll, describe, expect, test } from "bun:test";
import { normalizeUpstreamTokenUsage, transformToGoogleBody, transformGoogleEventToOpenAI } from "../../src/utils/transform";
import { loadProxyConfig } from "../../src/config/manager";

beforeAll(async () => {
  await loadProxyConfig();
});

describe("Unit Tests: transformToGoogleBody", () => {
  test("Basic message transformation", () => {
    const openaiBody = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Hello Gemini" }
      ],
      temperature: 0.5
    };

    const result = transformToGoogleBody(openaiBody, "test-project", false, "us-central1");

    expect(result.project).toBe("test-project");
    expect(result.model).toBe("gpt-4o"); // It passes through if no antigravity prefix
    expect(result.request.contents).toHaveLength(1);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[0].parts[0].text).toBe("Hello Gemini");
    expect(result.request.generationConfig.temperature).toBe(0.5);
  });

  test("Antigravity model prefix removal", () => {
    const openaiBody = {
      model: "antigravity-gemini-2.0-flash",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.model).toBe("gemini-2.0-flash");
  });

  test("Thinking level extraction for CLI", () => {
    const openaiBody = {
      model: "gemini-3-flash-thinking-medium",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", true, "us-central1"); // isCli = true
    expect(result.model).toBe("gemini-3-flash-preview");
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
  });

  test("Multi-turn conversation", () => {
    const openaiBody = {
      model: "gemini-1.5-pro",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.contents).toHaveLength(3);
    expect(result.request.contents[0].role).toBe("user");
    expect(result.request.contents[1].role).toBe("model"); // OpenAI assistant -> Google model
    expect(result.request.contents[2].role).toBe("user");
  });

  test("Tool transformation", () => {
    const openaiBody = {
      model: "gemini-1.5-pro",
      messages: [{ role: "user", content: "Check weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" }
              },
              required: ["location"]
            }
          }
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.tools).toBeDefined();
    expect(result.request.tools[0].functionDeclarations).toHaveLength(1);
    expect(result.request.tools[0].functionDeclarations[0].name).toBe("get_weather");
    expect(result.request.tools[0].functionDeclarations[0].parameters.properties.location).toBeDefined();
  });

  test("JSON object response format", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: { type: "json_object" }
    }, "p", false, "us-central1");

    expect(result.request.generationConfig.responseMimeType).toBe("application/json");
    expect(result.request.generationConfig.responseSchema).toBeUndefined();
    expect(result.request.systemInstruction.parts.at(-1).text).toContain("valid JSON object");
  });

  test("JSON schema response format", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "forced_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              status: { type: "string", enum: ["ok"] },
              count: { type: "integer" }
            },
            required: ["status", "count"]
          }
        }
      }
    }, "p", false, "us-central1");

    expect(result.request.generationConfig.responseMimeType).toBe("application/json");
    expect(result.request.generationConfig.responseSchema).toEqual({
      type: "OBJECT",
      properties: {
        status: { type: "STRING", enum: ["ok"] },
        count: { type: "INTEGER" }
      },
      required: ["status", "count"],
      title: "forced_result"
    });
  });

  test("Structured Claude response disables incompatible thinking", () => {
    const result = transformToGoogleBody({
      model: "antigravity-claude-sonnet-4-6-thinking",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "forced_result",
          schema: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"]
          }
        }
      }
    }, "p", false, "us-central1");

    expect(result.request.generationConfig.responseSchema.title).toBe("forced_result");
    expect(result.request.generationConfig.thinkingConfig).toBeUndefined();
  });

  test("GPT does not receive unsupported structured response fields", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gpt-oss-120b",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "forced_result",
          schema: { type: "object" }
        }
      }
    }, "p", false, "us-central1");

    expect(result.request.generationConfig.responseMimeType).toBeUndefined();
    expect(result.request.generationConfig.responseSchema).toBeUndefined();
  });

  test("Text response format leaves generation config unchanged", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [{ role: "user", content: "Return text" }],
      response_format: { type: "text" }
    }, "p", false, "us-central1");

    expect(result.request.generationConfig.responseMimeType).toBeUndefined();
    expect(result.request.generationConfig.responseSchema).toBeUndefined();
  });

  test("Claude Opus 4.6 Thinking mapping and budget", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.model).toBe("claude-opus-4-6-thinking");
    expect(result.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBe(32768);
  });

  test("Claude Opus 4.6 Thinking Low budget", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-low",
      messages: [{ role: "user", content: "Hi" }]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBe(8192);
  });

  test.each([
    ["antigravity-gemini-3.7-flash", "gemini-3.7-flash-tiered", "medium"],
    ["antigravity-gemini-3.7-flash-low", "gemini-3.7-flash-tiered", "low"],
    ["antigravity-gemini-3.7-flash-medium", "gemini-3.7-flash-tiered", "medium"],
    ["antigravity-gemini-3.7-flash-high", "gemini-3.7-flash-tiered", "high"],
    ["antigravity-gemini-3.6-flash", "gemini-3.6-flash-medium", "medium"],
    ["antigravity-gemini-3.6-flash-low", "gemini-3.6-flash-low", "low"],
    ["antigravity-gemini-3.6-flash-medium", "gemini-3.6-flash-medium", "medium"],
    ["antigravity-gemini-3.6-flash-high", "gemini-3.6-flash-high", "high"],
    ["antigravity-gemini-3.5-flash", "gemini-3.5-flash-low", "medium"],
    ["antigravity-gemini-3.5-flash-low", "gemini-3.5-flash-extra-low", "low"],
    ["antigravity-gemini-3.5-flash-medium", "gemini-3.5-flash-low", "medium"],
    ["antigravity-gemini-3.5-flash-high", "gemini-3-flash-agent", "high"],
    ["antigravity-gemini-3.1-pro", "gemini-pro-agent", "high"],
    ["antigravity-gemini-3.1-pro-low", "gemini-3.1-pro-low", "low"],
    ["antigravity-gemini-3.1-pro-high", "gemini-pro-agent", "high"]
  ])("maps current Gemini model %s", (model, runtimeModel, thinkingLevel) => {
    const result = transformToGoogleBody({
      model,
      messages: [{ role: "user", content: "Hi" }]
    }, "p", false, "us-central1");

    expect(result.model).toBe(runtimeModel);
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe(thinkingLevel);
  });

  test.each([
    ["antigravity-claude-sonnet-4-6-thinking", "claude-sonnet-4-6"],
    ["antigravity-claude-opus-4-6-thinking", "claude-opus-4-6-thinking"]
  ])("maps current non-Gemini model %s", (model, runtimeModel) => {
    const result = transformToGoogleBody({
      model,
      messages: [{ role: "user", content: "Hi" }]
    }, "p", false, "us-central1");

    expect(result.model).toBe(runtimeModel);
    expect(result.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
  });

  test("maps GPT-OSS without provider-specific thinking config", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gpt-oss-120b",
      messages: [{ role: "user", content: "Hi" }]
    }, "p", false, "us-central1");

    expect(result.model).toBe("gpt-oss-120b-medium");
    expect(result.request.generationConfig.thinkingConfig).toBeUndefined();
  });

  test("Claude tool call transformation with ID", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc123",
              type: "function",
              function: { name: "test_tool", arguments: "{}" }
            }
          ]
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    const funcCallPart = result.request.contents[0].parts.find((p: any) => p.functionCall);
    expect(funcCallPart).toBeDefined();
    expect(funcCallPart.functionCall.id).toBe("call_abc123");
  });

  test("Claude tool response transformation with ID", () => {
    const openaiBody = {
      model: "antigravity-claude-opus-4-6-thinking-high",
      messages: [
        {
          role: "tool",
          tool_call_id: "call_abc123",
          name: "test_tool",
          content: '{"result": "ok"}'
        }
      ]
    };

    const result = transformToGoogleBody(openaiBody, "p", false, "us-central1");
    const funcRespPart = result.request.contents[0].parts.find((p: any) => p.functionResponse);
    expect(funcRespPart).toBeDefined();
    expect(funcRespPart.functionResponse.id).toBe("call_abc123");
  });
});

describe("Unit Tests: transformGoogleEventToOpenAI", () => {
  test("Basic text response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{ text: "Hello world" }]
        },
        finishReason: "STOP"
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro", "req-123");
    expect(result).not.toBeNull();
    expect(result.choices[0].delta.content).toBe("Hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  test("Tool call response", () => {
    const googleData = {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: "get_weather",
              args: { location: "London" }
            }
          }]
        }
      }]
    };

    const result = transformGoogleEventToOpenAI(googleData, "gemini-1.5-pro");
    expect(result.choices[0].delta.tool_calls).toHaveLength(1);
    expect(result.choices[0].delta.tool_calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(result.choices[0].delta.tool_calls[0].function.arguments).location).toBe("London");
  });

  test("Empty/Invalid response", () => {
    const googleData = { candidates: [] };
    const result = transformGoogleEventToOpenAI(googleData, "model");
    expect(result).toBeNull();
  });

  test("preserves input, cached, visible output, and reasoning token metadata", () => {
    const result = transformGoogleEventToOpenAI({
      candidates: [],
      usageMetadata: {
        promptTokenCount: 1000,
        cachedContentTokenCount: 750,
        candidatesTokenCount: 12,
        thoughtsTokenCount: 20,
        totalTokenCount: 1032,
      }
    }, "gemini-3.7-flash", "req-usage");

    expect(result.usage).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 12,
      total_tokens: 1032,
      prompt_tokens_details: { cached_tokens: 750 },
      completion_tokens_details: { reasoning_tokens: 20 },
    });
    expect(result._tokenUsage).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 750,
      outputTokens: 12,
      reasoningTokens: 20,
      reasoningTokensReported: true,
      totalTokens: 1032,
    });
  });

  test("distinguishes an unreported reasoning count from a reported zero", () => {
    expect(normalizeUpstreamTokenUsage({ totalTokenCount: 3 })?.reasoningTokensReported).toBe(false);
    expect(normalizeUpstreamTokenUsage({ thoughtsTokenCount: 0 })?.reasoningTokensReported).toBe(true);
  });
});
