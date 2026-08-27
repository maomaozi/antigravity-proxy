import { beforeAll, describe, expect, test } from "bun:test";
import { loadProxyConfig } from "../../src/config/manager";
import {
  accumulateCompletionChunks,
  type CompletionChunk,
} from "../../src/core/completion";
import {
  adaptChatCompletionRequest,
  encodeChatCompletionChunk,
} from "../../src/api/openai/chat";
import {
  transformCompletionToGoogleBody,
  transformGoogleEventToCompletionChunk,
  transformToGoogleBody,
} from "../../src/utils/transform";

beforeAll(async () => {
  await loadProxyConfig();
});

describe("canonical completion core", () => {
  test("Chat adapter preserves the existing complex Google request contract", () => {
    const body = {
      model: "antigravity-gemini-3.7-flash-high",
      messages: [
        { role: "system", content: "Be precise." },
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this image and then use tools." },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Need both lookups",
          tool_calls: [
            {
              id: "sig:signature-a:call_a",
              type: "function",
              function: { name: "lookup.a", arguments: '{"q":"a"}' },
            },
            {
              id: "call_b",
              type: "function",
              function: { name: "lookup:b", arguments: '{"q":"b"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "sig:signature-a:call_a", content: '{"value":"A"}' },
        { role: "tool", tool_call_id: "call_b", content: '{"value":"B"}' },
        { role: "user", content: "Return the result." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup.a",
            description: "Lookup A",
            parameters: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "lookup:b",
            description: "Lookup B",
            parameters: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
          },
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "result",
          strict: true,
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        },
      },
      reasoning_effort: "high",
      max_tokens: 12345,
      stream: true,
      prompt_cache_key: "session-1",
    };

    const legacy = transformToGoogleBody(body, "project", false, "", "session", false);
    const canonical = adaptChatCompletionRequest(body);
    const refactored = transformCompletionToGoogleBody(canonical, "project", false, "", "session", false);

    // requestId is intentionally generated per transformation; everything else is the contract.
    expect({ ...refactored, requestId: "<generated>" }).toEqual({ ...legacy, requestId: "<generated>" });
  });

  test("Google parallel calls retain per-call thought signatures in canonical form", () => {
    const chunk = transformGoogleEventToCompletionChunk({
      candidates: [{
        content: {
          parts: [
            { thought: true, text: "thinking" },
            { functionCall: { id: "call_a", name: "a", args: { x: 1 } }, thoughtSignature: "sig-a" },
            { functionCall: { id: "call_b", name: "b", args: { x: 2 } } },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 80,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 11,
        totalTokenCount: 118,
      },
    }, "antigravity-gemini-3.7-flash", "chatcmpl-test", false);

    expect(chunk).not.toBeNull();
    expect(chunk?.reasoningDelta).toBe("thinking");
    expect(chunk?.toolCalls).toEqual([
      {
        index: 0,
        id: "sig:sig-a:call_a",
        name: "a",
        arguments: '{"x":1}',
        thoughtSignature: "sig-a",
      },
      {
        index: 1,
        id: "call_b",
        name: "b",
        arguments: '{"x":2}',
      },
    ]);
    expect(chunk?.finishReason).toBe("tool_calls");
    expect(chunk?.usage?.cachedInputTokens).toBe(80);
    expect(chunk?.usage?.reasoningTokens).toBe(11);
  });

  test("Chat encoder reproduces the legacy chunk wire shape exactly", () => {
    const canonical: CompletionChunk = {
      id: "chatcmpl-test",
      created: 123,
      model: "model",
      textDelta: "answer",
      reasoningDelta: "reason",
      toolCalls: [{
        index: 3,
        id: "sig:abc:call_1",
        name: "tool.name",
        arguments: '{"x":1}',
        thoughtSignature: "abc",
      }],
      finishReason: "tool_calls",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 2,
        reasoningTokens: 3,
        reasoningTokensReported: true,
        totalTokens: 15,
      },
    };

    expect(encodeChatCompletionChunk(canonical)).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 123,
      model: "model",
      choices: [{
        index: 0,
        delta: {
          content: "answer",
          reasoning_content: "reason",
          tool_calls: [{
            index: 3,
            id: "sig:abc:call_1",
            type: "function",
            function: { name: "tool.name", arguments: '{"x":1}' },
            extra_content: { google: { thought_signature: "abc" } },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });

  test("non-streaming accumulator preserves current append semantics and richest final usage", () => {
    const result = accumulateCompletionChunks([
      {
        id: "chatcmpl-test",
        created: 1,
        model: "model",
        reasoningDelta: "think ",
        textDelta: "hello ",
        toolCalls: [{ index: 0, id: "call_a", name: "a", arguments: "{}" }],
      },
      {
        id: "chatcmpl-test",
        created: 1,
        model: "model",
        reasoningDelta: "more",
        textDelta: "world",
        toolCalls: [{ index: 1, id: "call_b", name: "b", arguments: "{}" }],
        finishReason: "tool_calls",
        usage: {
          inputTokens: 10,
          cachedInputTokens: null,
          outputTokens: 3,
          reasoningTokens: 0,
          reasoningTokensReported: false,
          totalTokens: 13,
        },
      },
    ]);

    expect(result.text).toBe("hello world");
    expect(result.reasoning).toBe("think more");
    expect(result.toolCalls.map(call => call.id)).toEqual(["call_a", "call_b"]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage?.cachedInputTokens).toBeNull();
    expect(result.usage?.reasoningTokensReported).toBe(false);
  });
});

import {
  collectCompletionStream,
  type CompletionStreamEvent,
} from "../../src/core/completion";
import {
  createChatCompletionStreamEncoder,
  encodeChatCompletionResult,
} from "../../src/api/openai/chat";
import { createCompletionStreamTransformer } from "../../src/utils/transform";

describe("canonical completion streaming", () => {
  test("parses Google SSE once, keeps stable parallel tool indexes, usage, and DONE", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const payload of [
          { candidates: [{ content: { parts: [{ functionCall: { id: "call_a", name: "a", args: {} }, thoughtSignature: "sig-a" }] } }] },
          { candidates: [{ content: { parts: [{ functionCall: { id: "call_b", name: "b", args: {} } }] }, finishReason: "STOP" }] },
          { candidates: [], usageMetadata: { promptTokenCount: 9, cachedContentTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 11 } },
        ]) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const events: CompletionStreamEvent[] = [];
    const reader = source.pipeThrough(
      createCompletionStreamTransformer("model", "chatcmpl-stream", false),
    ).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(value);
    }

    const chunks = events.filter((event): event is Extract<CompletionStreamEvent, { type: "chunk" }> => event.type === "chunk").map(event => event.chunk);
    expect(chunks[0].toolCalls?.[0].index).toBe(0);
    expect(chunks[0].toolCalls?.[0].id).toBe("sig:sig-a:call_a");
    expect(chunks[1].toolCalls?.[0].index).toBe(1);
    expect(chunks[1].finishReason).toBe("tool_calls");
    expect(chunks[2].usage?.cachedInputTokens).toBe(4);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test("Chat SSE encoder preserves the legacy event framing", async () => {
    const stream = new ReadableStream<CompletionStreamEvent>({
      start(controller) {
        controller.enqueue({
          type: "chunk",
          chunk: {
            id: "chatcmpl-test",
            created: 123,
            model: "model",
            textDelta: "hello",
            finishReason: null,
          },
        });
        controller.enqueue({ type: "done" });
        controller.close();
      },
    }).pipeThrough(createChatCompletionStreamEncoder());

    expect(await new Response(stream).text()).toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":123,"model":"model","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    );
  });

  test("collects canonical stream directly for non-streaming Chat responses", async () => {
    const stream = new ReadableStream<CompletionStreamEvent>({
      start(controller) {
        controller.enqueue({ type: "chunk", chunk: { id: "id", created: 1, model: "model", reasoningDelta: "r", textDelta: "a" } });
        controller.enqueue({ type: "chunk", chunk: {
          id: "id", created: 1, model: "model", textDelta: "b", finishReason: "length",
          usage: { inputTokens: 5, cachedInputTokens: 2, outputTokens: 2, reasoningTokens: 1, reasoningTokensReported: true, totalTokens: 8 },
        } });
        controller.enqueue({ type: "done" });
        controller.close();
      },
    });

    const result = await collectCompletionStream(stream);
    expect(result.text).toBe("ab");
    expect(result.reasoning).toBe("r");
    expect(result.finishReason).toBe("length");

    expect(encodeChatCompletionResult("chatcmpl-final", "model", result, 456)).toEqual({
      id: "chatcmpl-final",
      object: "chat.completion",
      created: 456,
      model: "model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ab", reasoning_content: "r", tool_calls: undefined },
        finish_reason: "length",
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 8,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    });
  });
});

import { validateCompletionRequestForGoogle } from "../../src/utils/transform";

describe("canonical completion validation", () => {
  test("validates tool call/result ordering after Chat adaptation", () => {
    const valid = adaptChatCompletionRequest({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "user", content: "run both" },
        { role: "assistant", tool_calls: [
          { id: "sig:sig-a:call_a", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "b", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "sig:sig-a:call_a", content: "a" },
        { role: "tool", tool_call_id: "call_b", content: "b" },
        { role: "user", content: "continue" },
      ],
    });
    expect(validateCompletionRequestForGoogle(valid)).toBeUndefined();

    const invalid = adaptChatCompletionRequest({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "user", content: "run both" },
        { role: "assistant", tool_calls: [
          { id: "call_a", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "b", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "call_a", content: "a" },
        { role: "user", content: "continue" },
      ],
    });
    expect(validateCompletionRequestForGoogle(invalid)).toContain("call_b");
  });
});
