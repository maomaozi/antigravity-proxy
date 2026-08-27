
import { beforeAll, describe, expect, test } from "bun:test";
import { createOpenAIStreamTransformer, normalizeUpstreamTokenUsage, transformToGoogleBody, transformGoogleEventToOpenAI, validateOpenAIRequestForGoogle } from "../../src/utils/transform";
import { getProxyConfig, loadProxyConfig } from "../../src/config/manager";
import { getSignature } from "../../src/utils/cache";

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

  test("uses OpenAI reasoning_effort for the thinking level", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "Hi" }]
    }, "p", false, "us-central1");

    expect(result.model).toBe("gemini-3.7-flash-tiered");
    expect(result.request.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
    expect(result.request.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
    expect(result.request.generationConfig.temperature).toBeUndefined();
    expect(result.request.generationConfig.topP).toBeUndefined();
    expect(result.request.generationConfig.candidateCount).toBeUndefined();
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

  test("caps Gemini 3 output tokens at the model protocol limit", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash-high",
      max_tokens: 999999,
      messages: [{ role: "user", content: "Hi" }]
    }, "p", false, "us-central1");

    expect(result.request.generationConfig.maxOutputTokens).toBe(65536);
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

  test("restores original Gemini tool IDs and thought signatures", () => {
    const syntheticId = "sig:c2lnbmF0dXJl:call_abc:123";
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "user", content: "Run the tool" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: syntheticId,
            type: "function",
            function: { name: "test_tool", arguments: "{}" }
          }]
        },
        {
          role: "tool",
          tool_call_id: syntheticId,
          content: '{"result":"ok"}'
        }
      ]
    }, "p", false, "us-central1");

    const funcCallPart = result.request.contents[1].parts.find((p: any) => p.functionCall);
    const funcRespPart = result.request.contents[2].parts.find((p: any) => p.functionResponse);
    expect(funcCallPart.functionCall.id).toBe("call_abc:123");
    expect(funcCallPart.thoughtSignature).toBe("c2lnbmF0dXJl");
    expect(funcRespPart.functionResponse.id).toBe("call_abc:123");
    expect(funcRespPart.functionResponse.name).toBe("test_tool");
  });

  test("prefers an explicit Gemini thought signature", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_abc123",
          type: "function",
          extra_content: { google: { thought_signature: "explicit-signature" } },
          function: { name: "test_tool", arguments: "{}" }
        }]
      }]
    }, "p", false, "us-central1");

    const funcCallPart = result.request.contents[0].parts.find((p: any) => p.functionCall);
    expect(funcCallPart.functionCall.id).toBe("call_abc123");
    expect(funcCallPart.thoughtSignature).toBe("explicit-signature");
  });

  test("groups parallel function responses and preserves call IDs and names", () => {
    const firstId = "sig:first-signature:call_first";
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.1-pro",
      messages: [
        { role: "user", content: "Look up both" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: firstId, type: "function", function: { name: "lookup_a", arguments: "{}" } },
            { id: "call_second", type: "function", function: { name: "lookup_b", arguments: "{}" } }
          ]
        },
        { role: "tool", tool_call_id: firstId, content: '{"value":"a"}' },
        { role: "tool", tool_call_id: "call_second", content: '{"value":"b"}' }
      ]
    }, "p", false, "us-central1");

    expect(result.model).toBe("gemini-pro-agent");
    expect(result.request.contents).toHaveLength(3);
    const calls = result.request.contents[1].parts;
    expect(calls[0].functionCall.id).toBe("call_first");
    expect(calls[0].thoughtSignature).toBe("first-signature");
    expect(calls[1].functionCall.id).toBe("call_second");
    expect(calls[1].thoughtSignature).toBeUndefined();
    const responses = result.request.contents[2].parts;
    expect(responses).toHaveLength(2);
    expect(responses.map((part: any) => part.functionResponse.name)).toEqual(["lookup_a", "lookup_b"]);
    expect(responses.map((part: any) => part.functionResponse.id)).toEqual(["call_first", "call_second"]);
  });

  test("keeps sequential function response turns separate", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "user", content: "Run in sequence" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "first", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "one" },
        { role: "assistant", tool_calls: [{ id: "call_2", type: "function", function: { name: "second", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_2", content: "two" }
      ]
    }, "p", false, "us-central1");

    expect(result.request.contents.map((content: any) => content.role)).toEqual([
      "user", "model", "user", "model", "user"
    ]);
    expect(result.request.contents[2].parts).toHaveLength(1);
    expect(result.request.contents[4].parts).toHaveLength(1);
  });

  test("sanitizes colliding and overlong function names deterministically", () => {
    const longName = `9.${"x".repeat(140)}`;
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [{ role: "user", content: "Use a tool" }],
      tools: ["same.name", "same:name", longName].map(name => ({
        type: "function",
        function: { name, parameters: { type: "object", properties: {} } }
      }))
    }, "p", false, "us-central1");

    const names = result.request.tools[0].functionDeclarations.map((declaration: any) => declaration.name);
    expect(new Set(names).size).toBe(3);
    expect(names.every((name: string) => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(name))).toBe(true);
    expect(result.request.tools[0].functionDeclarations.every((declaration: any) => declaration.parameters === undefined)).toBe(true);
  });

  test("keeps supported Schema constraints and resolves local JSON Schema refs", () => {
    const result = transformToGoogleBody({
      model: "antigravity-gemini-3.7-flash",
      messages: [{ role: "user", content: "Use a tool" }],
      tools: [{
        type: "function",
        function: {
          name: "constrained",
          parameters: {
            type: "object",
            additionalProperties: false,
            $defs: {
              count: { type: "integer", minimum: 1, maximum: 5 }
            },
            properties: {
              count: { $ref: "#/$defs/count" },
              label: { type: ["string", "null"], minLength: 2, examples: ["ok"] }
            },
            required: ["count"]
          }
        }
      }]
    }, "p", false, "us-central1");

    const schema = result.request.tools[0].functionDeclarations[0].parameters;
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.$defs).toBeUndefined();
    expect(schema.properties.count).toEqual({ type: "INTEGER", minimum: 1, maximum: 5 });
    expect(schema.properties.label).toEqual({
      type: "STRING",
      nullable: true,
      minLength: 2,
      example: "ok"
    });
  });

  test("uses the current googleSearch tool field", () => {
    const config = getProxyConfig();
    const previous = config.features.googleSearchGrounding;
    config.features.googleSearchGrounding = true;
    try {
      const result = transformToGoogleBody({
        model: "antigravity-gemini-3.7-flash",
        messages: [{ role: "user", content: "Search" }]
      }, "p", false, "us-central1");
      expect(result.request.tools).toContainEqual({ googleSearch: {} });
      expect(result.request.tools.some((tool: any) => tool.googleSearchRetrieval)).toBe(false);
    } finally {
      config.features.googleSearchGrounding = previous;
    }
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

  test("exposes Gemini thought signatures through OpenAI-compatible metadata", () => {
    const result = transformGoogleEventToOpenAI({
      candidates: [{
        content: {
          parts: [{
            functionCall: { id: "call_abc123", name: "get_weather", args: {} },
            thoughtSignature: "signature-value"
          }]
        }
      }]
    }, "gemini-3.7-flash");

    const toolCall = result.choices[0].delta.tool_calls[0];
    expect(toolCall.id).toBe("sig:signature-value:call_abc123");
    expect(toolCall.extra_content.google.thought_signature).toBe("signature-value");
  });

  test("does not copy the first thought signature to later parallel calls", () => {
    const result = transformGoogleEventToOpenAI({
      candidates: [{
        content: {
          parts: [
            { functionCall: { id: "call_a", name: "a", args: {} }, thoughtSignature: "signature-a" },
            { functionCall: { id: "call_b", name: "b", args: {} } }
          ]
        }
      }]
    }, "gemini-3.7-flash");

    expect(result.choices[0].delta.tool_calls[0].id).toBe("sig:signature-a:call_a");
    expect(result.choices[0].delta.tool_calls[1].id).toBe("call_b");
    expect(result.choices[0].delta.tool_calls[1].extra_content).toBeUndefined();
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

  test("distinguishes unreported cached input from a reported zero", () => {
    expect(normalizeUpstreamTokenUsage({ totalTokenCount: 3 })?.cachedInputTokens).toBeNull();
    expect(normalizeUpstreamTokenUsage({ cachedContentTokenCount: 0 })?.cachedInputTokens).toBe(0);

    const result = transformGoogleEventToOpenAI({
      candidates: [],
      usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 }
    }, "model");
    expect(result.usage.prompt_tokens_details.cached_tokens).toBeNull();
  });

  test("distinguishes an unreported reasoning count from a reported zero", () => {
    expect(normalizeUpstreamTokenUsage({ totalTokenCount: 3 })?.reasoningTokensReported).toBe(false);
    expect(normalizeUpstreamTokenUsage({ thoughtsTokenCount: 0 })?.reasoningTokensReported).toBe(true);
  });

  test("caches a thought signature delivered in a later empty part", async () => {
    const sessionId = `stream-signature-${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ thought: true, text: "reasoning" }] } }]
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          candidates: [{
            content: { parts: [{ thought: true, text: "", thoughtSignature: "late-signature" }] },
            finishReason: "STOP"
          }]
        })}\n\n`));
        controller.close();
      }
    });

    await new Response(source.pipeThrough(
      createOpenAIStreamTransformer("gemini-3.7-flash", "req-stream", false, sessionId)
    )).text();
    expect(getSignature(sessionId, "reasoning")).toBe("late-signature");
  });

  test("assigns stable unique indexes to parallel calls split across stream events", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        for (const [id, name] of [["call_a", "a"], ["call_b", "b"]]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ functionCall: { id, name, args: {} } }] } }]
          })}\n\n`));
        }
        controller.close();
      }
    });

    const output = await new Response(source.pipeThrough(
      createOpenAIStreamTransformer("gemini-3.7-flash", "req-indexes", false)
    )).text();
    const events = output.trim().split("\n\n").map(line => JSON.parse(line.slice(6)));
    expect(events.map(event => event.choices[0].delta.tool_calls[0].index)).toEqual([0, 1]);
  });
});

describe("Unit Tests: Google request validation", () => {
  test("rejects assistant prefill before contacting Google", () => {
    expect(validateOpenAIRequestForGoogle({
      model: "antigravity-gemini-3.7-flash",
      messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "prefix" }]
    })).toContain("cannot end");
  });

  test("does not apply the Gemini 3 prefill rule to non-Gemini models", () => {
    expect(validateOpenAIRequestForGoogle({
      model: "antigravity-claude-sonnet-4-6-thinking",
      messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "prefix" }]
    })).toBeUndefined();
  });

  test("accepts name-less parallel responses that match pending call IDs", () => {
    expect(validateOpenAIRequestForGoogle({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "user", content: "Run both" },
        { role: "assistant", tool_calls: [
          { id: "call_a", function: { name: "a", arguments: "{}" } },
          { id: "call_b", function: { name: "b", arguments: "{}" } }
        ] },
        { role: "tool", tool_call_id: "call_a", content: "a" },
        { role: "tool", tool_call_id: "call_b", content: "b" }
      ]
    })).toBeUndefined();
  });

  test("rejects missing parallel responses and malformed arguments", () => {
    expect(validateOpenAIRequestForGoogle({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "user", content: "Run both" },
        { role: "assistant", tool_calls: [
          { id: "call_a", function: { name: "a", arguments: "{}" } },
          { id: "call_b", function: { name: "b", arguments: "{}" } }
        ] },
        { role: "tool", tool_call_id: "call_a", content: "a" },
        { role: "user", content: "continue" }
      ]
    })).toContain("call_b");

    expect(validateOpenAIRequestForGoogle({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "user", content: "Run" },
        { role: "assistant", tool_calls: [
          { id: "call_bad", function: { name: "bad", arguments: "{" } }
        ] },
        { role: "tool", tool_call_id: "call_bad", content: "x" }
      ]
    })).toContain("invalid JSON");
  });
});
