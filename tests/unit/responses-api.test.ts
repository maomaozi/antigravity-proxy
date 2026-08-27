import { beforeAll, describe, expect, test } from "bun:test";
import {
  adaptResponsesRequest,
  createResponsesStreamEncoder,
  encodeResponsesResult,
  validateResponsesRequest,
} from "../../src/api/openai/responses";
import { transformCompletionToGoogleBody } from "../../src/utils/transform";
import { loadProxyConfig } from "../../src/config/manager";

beforeAll(async () => {
  await loadProxyConfig();
});

describe("Responses API request adapter", () => {
  test("maps supported Responses fields into the canonical completion request", () => {
    const body = {
      model: "antigravity-gemini-3.7-flash",
      instructions: "Be concise.",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe this" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "auto" },
        ],
      }],
      tools: [{
        type: "function",
        name: "lookup_weather",
        description: "Look up weather",
        strict: true,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      text: {
        format: {
          type: "json_schema",
          name: "weather_result",
          strict: true,
          schema: {
            type: "object",
            properties: { temperature: { type: "number" } },
            required: ["temperature"],
          },
        },
      },
      reasoning: { effort: "high" },
      max_output_tokens: 1234,
      temperature: 0.2,
      top_p: 0.8,
      stream: true,
      prompt_cache_key: "session-1",
      metadata: { source: "test" },
    };

    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request).toEqual({
      model: "antigravity-gemini-3.7-flash",
      messages: [
        { role: "system", content: "Be concise." },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image", url: "data:image/png;base64,aGVsbG8=" },
          ],
        },
      ],
      tools: [{
        name: "lookup_weather",
        description: "Look up weather",
        strict: true,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      responseFormat: {
        type: "json_schema",
        name: "weather_result",
        strict: true,
        schema: {
          type: "object",
          properties: { temperature: { type: "number" } },
          required: ["temperature"],
        },
      },
      reasoningEffort: "high",
      maxOutputTokens: 1234,
      temperature: 0.2,
      topP: 0.8,
      stream: true,
      promptCacheKey: "session-1",
      metadata: { source: "test" },
    });
  });

  test("accepts the Codex CLI Responses request extensions used for stateless sessions", () => {
    const body = {
      model: "antigravity-gemini-3.7-flash",
      instructions: "Act as a coding agent.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Run a command",
        strict: false,
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { summary: "auto" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "codex-thread-1",
      client_metadata: { source: "codex_exec" },
    };

    expect(validateResponsesRequest(body)).toBeUndefined();
    const adapted = adaptResponsesRequest(body);
    expect(adapted.model).toBe(body.model);
    expect(adapted.stream).toBe(true);
    expect(adapted.promptCacheKey).toBe("codex-thread-1");
    expect(adapted.tools?.map(tool => tool.name)).toEqual(["exec_command"]);
  });

  test("groups reasoning, parallel function calls, and their outputs into canonical turns", () => {
    const body = {
      model: "antigravity-gemini-3.7-flash",
      input: [
        { role: "user", content: "Look up both" },
        {
          id: "rs_old",
          type: "reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: "Need both tools" }],
        },
        {
          id: "fc_a",
          type: "function_call",
          call_id: "sig:first-signature:call_a",
          name: "lookup_a",
          arguments: '{"q":"a"}',
          status: "completed",
        },
        {
          id: "fc_b",
          type: "function_call",
          call_id: "call_b",
          name: "lookup_b",
          arguments: '{"q":"b"}',
          status: "completed",
        },
        {
          type: "function_call_output",
          call_id: "sig:first-signature:call_a",
          output: '{"value":"A"}',
        },
        {
          type: "function_call_output",
          call_id: "call_b",
          output: '{"value":"B"}',
        },
        { role: "user", content: "Summarize" },
      ],
    };

    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request.messages).toEqual([
      { role: "user", content: "Look up both" },
      {
        role: "assistant",
        content: null,
        reasoningContent: "Need both tools",
        toolCalls: [
          { id: "sig:first-signature:call_a", name: "lookup_a", arguments: '{"q":"a"}' },
          { id: "call_b", name: "lookup_b", arguments: '{"q":"b"}' },
        ],
      },
      { role: "tool", content: '{"value":"A"}', toolCallId: "sig:first-signature:call_a" },
      { role: "tool", content: '{"value":"B"}', toolCallId: "call_b" },
      { role: "user", content: "Summarize" },
    ]);

    const google = transformCompletionToGoogleBody(request, "project", false, "", "session");
    const calls = google.request.contents[1].parts.filter((part: any) => part.functionCall);
    const outputs = google.request.contents[2].parts.filter((part: any) => part.functionResponse);
    expect(calls[0].functionCall.id).toBe("call_a");
    expect(calls[0].thoughtSignature).toBe("first-signature");
    expect(calls[1].functionCall.id).toBe("call_b");
    expect(calls[1].thoughtSignature).toBeUndefined();
    expect(outputs.map((part: any) => part.functionResponse.id)).toEqual(["call_a", "call_b"]);
  });

  test("rejects Responses-only platform features that the proxy cannot implement faithfully", () => {
    expect(validateResponsesRequest({ model: "m", input: "hi", previous_response_id: "resp_old" })).toContain("previous_response_id");
    expect(validateResponsesRequest({ model: "m", input: "hi", store: true })).toContain("store=true");
    expect(validateResponsesRequest({ model: "m", input: "hi", background: true })).toContain("background");
    expect(validateResponsesRequest({ model: "m", input: "hi", include: ["reasoning.encrypted_content"] })).toBeUndefined();
    expect(validateResponsesRequest({ model: "m", input: "hi", include: ["file_search_call.results"] })).toContain("include");
    expect(validateResponsesRequest({ model: "m", input: "hi", tools: [{ type: "web_search" }] })).toContain("function tools");
    expect(validateResponsesRequest({ model: "m", input: "hi", tool_choice: "required" })).toContain("tool_choice");
    expect(validateResponsesRequest({ model: "m", input: "hi", parallel_tool_calls: false })).toContain("parallel_tool_calls=false");
    expect(validateResponsesRequest({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }],
    })).toContain("data URL");
  });
});

describe("Responses API final response encoder", () => {
  test("emits ordered reasoning, message, function-call output items and Responses usage", () => {
    const response = encodeResponsesResult({
      responseId: "resp_test",
      createdAt: 1700000000,
      requestBody: {
        model: "antigravity-gemini-3.7-flash",
        instructions: "Be useful",
        tools: [{ type: "function", name: "lookup", parameters: {}, strict: false }],
        reasoning: { effort: "high" },
        max_output_tokens: 500,
        temperature: 0.2,
        top_p: 0.9,
        prompt_cache_key: "cache-key",
        metadata: { a: "b" },
      },
      result: {
        text: "Visible answer",
        reasoning: "Private reasoning text",
        toolCalls: [{
          index: 0,
          id: "sig:abc:call_1",
          name: "lookup",
          arguments: '{"q":"x"}',
          thoughtSignature: "abc",
        }],
        finishReason: "tool_calls",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 12,
          reasoningTokens: 8,
          reasoningTokensReported: true,
          totalTokens: 120,
        },
      },
    });

    expect(response.id).toBe("resp_test");
    expect(response.object).toBe("response");
    expect(response.status).toBe("completed");
    expect(response.output_text).toBe("Visible answer");
    expect(response.output.map((item: any) => item.type)).toEqual(["reasoning", "message", "function_call"]);
    expect(response.output[0].content).toEqual([{ type: "reasoning_text", text: "Private reasoning text" }]);
    expect(response.output[1].content).toEqual([{ type: "output_text", text: "Visible answer", annotations: [] }]);
    expect(response.output[2]).toMatchObject({
      type: "function_call",
      call_id: "sig:abc:call_1",
      name: "lookup",
      arguments: '{"q":"x"}',
      status: "completed",
    });
    expect(response.usage).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 8 },
      total_tokens: 120,
    });
  });

  test("maps Chat finish reasons into Responses incomplete status", () => {
    const response = encodeResponsesResult({
      responseId: "resp_length",
      createdAt: 1700000000,
      requestBody: { model: "m" },
      result: { text: "partial", reasoning: "", toolCalls: [], finishReason: "length" },
    });
    expect(response.status).toBe("incomplete");
    expect(response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });
});

describe("Responses API streaming encoder", () => {
  const eventsFrom = async (chunks: any[]) => {
    const source = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const text = await new Response(source.pipeThrough(createResponsesStreamEncoder({
      responseId: "resp_stream",
      model: "antigravity-gemini-3.7-flash",
      createdAt: 1700000000,
      requestBody: { model: "antigravity-gemini-3.7-flash", stream: true },
    }))).text();
    return text.trim().split("\n\n").map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
  };

  test("emits the complete text lifecycle and final response without Chat [DONE]", async () => {
    const events = await eventsFrom([
      { type: "chunk", chunk: { id: "resp_stream", created: 1700000000, model: "m", textDelta: "hel" } },
      { type: "chunk", chunk: { id: "resp_stream", created: 1700000000, model: "m", textDelta: "lo", finishReason: "stop", usage: {
        inputTokens: 10, cachedInputTokens: null, outputTokens: 2, reasoningTokens: 0, reasoningTokensReported: false, totalTokens: 12,
      } } },
      { type: "done" },
    ]);

    expect(events.map(event => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[3].delta).toBe("hel");
    expect(events[4].delta).toBe("lo");
    expect(events.at(-1).response.output_text).toBe("hello");
    expect(events.at(-1).response.usage.input_tokens_details.cached_tokens).toBe(0);
  });

  test("streams reasoning and parallel function calls as independent ordered output items", async () => {
    const events = await eventsFrom([
      { type: "chunk", chunk: { id: "resp_stream", created: 1700000000, model: "m", reasoningDelta: "think" } },
      { type: "chunk", chunk: { id: "resp_stream", created: 1700000000, model: "m", toolCalls: [
        { index: 0, id: "sig:sig-a:call_a", name: "a", arguments: "{}", thoughtSignature: "sig-a" },
        { index: 1, id: "call_b", name: "b", arguments: '{"x":1}' },
      ], finishReason: "tool_calls" } },
      { type: "done" },
    ]);

    const types = events.map(event => event.type);
    expect(types).toContain("response.reasoning_text.delta");
    expect(types.filter(type => type === "response.output_item.added")).toHaveLength(3);
    expect(types.filter(type => type === "response.function_call_arguments.delta")).toHaveLength(2);
    const completed = events.at(-1).response;
    expect(completed.output.map((item: any) => item.type)).toEqual(["reasoning", "function_call", "function_call"]);
    expect(completed.output[1].call_id).toBe("sig:sig-a:call_a");
    expect(completed.output[2].call_id).toBe("call_b");
  });
});

test("Responses streaming uses response.incomplete for max_output_tokens", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "chunk", chunk: { id: "resp_short", created: 1700000000, model: "m", textDelta: "{" } });
      controller.enqueue({ type: "chunk", chunk: { id: "resp_short", created: 1700000000, model: "m", finishReason: "length" } });
      controller.enqueue({ type: "done" });
      controller.close();
    },
  });
  const text = await new Response(source.pipeThrough(createResponsesStreamEncoder({
    responseId: "resp_short",
    model: "m",
    createdAt: 1700000000,
    requestBody: { model: "m", stream: true, max_output_tokens: 1 },
  }))).text();
  const events = text.trim().split("\n\n").map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
  expect(events.at(-1).type).toBe("response.incomplete");
  expect(events.at(-1).response.status).toBe("incomplete");
  expect(events.at(-1).response.incomplete_details).toEqual({ reason: "max_output_tokens" });
});
