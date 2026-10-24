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
  test("converts Codex boolean tool enums and structured output enums for Google", () => {
    const parameters = {
      type: "object",
      properties: { enabled: { type: "boolean", enum: [true] } },
      required: ["enabled"],
    };
    const request = adaptResponsesRequest({
      model: "antigravity-gemini-3.8-flash",
      input: "Use the tool",
      tools: [{ type: "function", name: "enable", parameters }],
      text: { format: { type: "json_schema", name: "result", schema: parameters } },
    });

    for (const aggressive of [false, true]) {
      const result = transformCompletionToGoogleBody(request, "p", "us-central1", undefined, aggressive);
      const toolSchema = result.request.tools[0].functionDeclarations[0].parameters;
      expect(toolSchema.properties.enabled).toEqual({ type: "BOOLEAN", description: "Allowed values: true." });
      expect(toolSchema.required).toEqual(["enabled"]);
      expect(result.request.generationConfig.responseSchema.properties.enabled).toEqual(toolSchema.properties.enabled);
    }
  });

  test("maps supported Responses fields into the canonical completion request", () => {
    const body = {
      model: "antigravity-gemini-3.8-flash",
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
      model: "antigravity-gemini-3.8-flash",
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
      model: "antigravity-gemini-3.8-flash",
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

  test("accepts Codex namespace, custom, web_search, and local_shell tool declarations", () => {
    const body = {
      model: "antigravity-gemini-3.8-flash",
      input: "Use the available tools when useful.",
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          description: "Sub-agent tools",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Spawn an agent",
              strict: false,
              parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
              },
            },
            {
              type: "custom",
              name: "delegate_text",
              description: "Delegate freeform text",
              format: { type: "text", syntax: "plain", definition: "freeform text" },
            },
          ],
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
        { type: "web_search", external_web_access: true },
        { type: "local_shell" },
      ],
    };

    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request.webSearch).toBe(true);
    expect(request.tools).toHaveLength(3);

    const google = transformCompletionToGoogleBody(request, "project", "", "session");
    const declarations = google.request.tools.find((tool: any) => tool.functionDeclarations)?.functionDeclarations ?? [];
    expect(declarations).toHaveLength(3);
    expect(google.request.tools.some((tool: any) => tool.googleSearch)).toBe(false);
  });

  test("maps standalone Responses web_search to Gemini native Google Search", () => {
    const request = adaptResponsesRequest({
      model: "antigravity-gemini-3.8-flash",
      input: "Search for current information",
      tools: [{ type: "web_search", external_web_access: true }],
    });
    expect(request.tools).toBeUndefined();
    expect(request.webSearch).toBe(true);
    const google = transformCompletionToGoogleBody(request, "project", "", "session");
    expect(google.request.tools).toEqual([{ googleSearch: {} }]);
  });

  test("replays a function and a custom tool that reuse the same upstream call ID", () => {
    const firstId = "sig:command-signature:call_1555473";
    const secondId = "sig:patch-signature:call_1555473";
    const body = {
      model: "antigravity-gemini-3.8-flash",
      input: [
        { role: "user", content: "Inspect, then patch" },
        { type: "function_call", call_id: firstId, name: "exec_command", arguments: '{"cmd":"pwd"}' },
        { type: "function_call_output", call_id: firstId, output: "workspace" },
        { type: "custom_tool_call", call_id: secondId, name: "apply_patch", input: "PATCH" },
        { type: "custom_tool_call_output", call_id: secondId, output: "patched" },
      ],
    };
    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    const { contents } = transformCompletionToGoogleBody(request, "project", "", "session").request;
    expect(contents[1].parts[0].functionCall.name).toBe("exec_command");
    expect(contents[2].parts[0].functionResponse.name).toBe("exec_command");
    expect(contents[4].parts[0].functionResponse.name).toBe(contents[3].parts[0].functionCall.name);
    expect(contents[4].parts[0].functionResponse.name).not.toBe("exec_command");
    expect(contents[1].parts[0].thoughtSignature).toBe("command-signature");
    expect(contents[3].parts[0].thoughtSignature).toBe("patch-signature");
  });

  test("groups reasoning, parallel function calls, and their outputs into canonical turns", () => {
    const body = {
      model: "antigravity-gemini-3.8-flash",
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

    const google = transformCompletionToGoogleBody(request, "project", "", "session");
    const calls = google.request.contents[1].parts.filter((part: any) => part.functionCall);
    const outputs = google.request.contents[2].parts.filter((part: any) => part.functionResponse);
    expect(calls[0].functionCall.id).toBe("call_a");
    expect(calls[0].thoughtSignature).toBe("first-signature");
    expect(calls[1].functionCall.id).toBe("call_b");
    expect(calls[1].thoughtSignature).toBeUndefined();
    expect(outputs.map((part: any) => part.functionResponse.id)).toEqual(["call_a", "call_b"]);
  });

  test("preserves Codex view_image output as a Gemini multimodal function response", () => {
    const imageUrl = "data:image/png;base64,aGVsbG8=";
    const body = {
      model: "antigravity-gemini-3.8-flash",
      input: [
        { role: "user", content: "Inspect the local image" },
        {
          type: "function_call",
          call_id: "call_view_image",
          name: "view_image",
          arguments: '{"path":"/tmp/test.png"}',
        },
        {
          type: "function_call_output",
          call_id: "call_view_image",
          output: [{ type: "input_image", image_url: imageUrl, detail: "high" }],
        },
      ],
    };

    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request.messages[2]).toEqual({
      role: "tool",
      content: [{ type: "image", url: imageUrl }],
      toolCallId: "call_view_image",
    });

    const google = transformCompletionToGoogleBody(request, "project", "", "session");
    expect(google.request.contents[2].parts).toEqual([{
      functionResponse: {
        id: "call_view_image",
        name: "view_image",
        response: { result: "" },
        parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
      },
    }]);
  });

  test("rejects Responses-only platform features that the proxy cannot implement faithfully", () => {
    expect(validateResponsesRequest({ model: "m", input: "hi", previous_response_id: "resp_old" })).toContain("previous_response_id");
    expect(validateResponsesRequest({ model: "m", input: "hi", store: true })).toContain("store=true");
    expect(validateResponsesRequest({ model: "m", input: "hi", background: true })).toContain("background");
    expect(validateResponsesRequest({ model: "m", input: "hi", include: ["reasoning.encrypted_content"] })).toBeUndefined();
    expect(validateResponsesRequest({ model: "m", input: "hi", include: ["file_search_call.results"] })).toContain("include");
    expect(validateResponsesRequest({ model: "m", input: "hi", tools: [{ type: "code_interpreter" }] })).toContain("Unsupported Responses tool type");
    expect(validateResponsesRequest({ model: "m", input: "hi", tool_choice: "required" })).toContain("tool_choice");
    expect(validateResponsesRequest({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }],
    })).toContain("data URL");
  });

  test("accepts serial tool calls and validates the parallel_tool_calls flag", () => {
    for (const parallel_tool_calls of [false, true, undefined]) {
      expect(validateResponsesRequest({ model: "m", input: "hi", parallel_tool_calls })).toBeUndefined();
    }
    for (const parallel_tool_calls of ["false", 0, {}]) {
      expect(validateResponsesRequest({ model: "m", input: "hi", parallel_tool_calls })).toContain("must be a boolean");
    }
  });
});

describe("Responses API final response encoder", () => {
  test("limits serial tool responses to the first call and preserves its round-trip history", () => {
    const result = {
      text: "", reasoning: "",
      toolCalls: [
        { index: 0, id: "sig:signature:call_a", name: "a", arguments: '{"enabled":true}' },
        { index: 1, id: "call_b", name: "b", arguments: "{}" },
      ],
      finishReason: "tool_calls" as const,
    };
    const requestBody = { model: "antigravity-gemini-3.8-flash", input: "Use tools", parallel_tool_calls: false };
    const response = encodeResponsesResult({ responseId: "resp_serial", createdAt: 1, requestBody, result });
    expect(response.parallel_tool_calls).toBe(false);
    expect(response.output).toHaveLength(1);
    expect(response.output[0]).toMatchObject({ call_id: "sig:signature:call_a", name: "a", arguments: '{"enabled":true}' });
    expect(result.toolCalls).toHaveLength(2);

    const nextBody = { ...requestBody, input: [
      { role: "user", content: "Use tools" },
      ...response.output,
      { type: "function_call_output", call_id: response.output[0].call_id, output: "done" },
    ] };
    expect(validateResponsesRequest(nextBody)).toBeUndefined();
    const google = transformCompletionToGoogleBody(adaptResponsesRequest(nextBody), "p", "");
    expect(google.request.contents[1].parts).toEqual([{
      functionCall: { name: "a", args: { enabled: true }, id: "call_a" },
      thoughtSignature: "signature",
    }]);
    expect(google.request.contents[2].parts[0].functionResponse).toMatchObject({ id: "call_a", name: "a" });

    for (const parallel_tool_calls of [true, undefined]) {
      const parallel = encodeResponsesResult({ responseId: "resp_parallel", createdAt: 1, requestBody: { ...requestBody, parallel_tool_calls }, result });
      expect(parallel.output).toHaveLength(2);
    }
  });

  test("accepts serial responses with zero or one tool call", () => {
    for (const toolCalls of [[], [{ index: 0, id: "call_a", name: "a", arguments: "{}" }]]) {
      const response = encodeResponsesResult({
        responseId: "resp_serial", createdAt: 1, requestBody: { parallel_tool_calls: false },
        result: { text: "", reasoning: "", toolCalls, finishReason: "stop" },
      });
      expect(response.output).toHaveLength(toolCalls.length);
    }
  });

  test("emits ordered reasoning, message, function-call output items and Responses usage", () => {
    const response = encodeResponsesResult({
      responseId: "resp_test",
      createdAt: 1700000000,
      requestBody: {
        model: "antigravity-gemini-3.8-flash",
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

  test("restores namespace and custom tool calls in Responses output", () => {
    const requestBody = {
      model: "antigravity-gemini-3.8-flash",
      input: "Use tools",
      tools: [
        {
          type: "namespace",
          name: "multi_agent_v1",
          description: "Agent tools",
          tools: [{
            type: "function",
            name: "spawn_agent",
            description: "Spawn",
            parameters: { type: "object", properties: { message: { type: "string" } } },
          }],
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Patch",
          format: { type: "text", syntax: "plain", definition: "patch text" },
        },
      ],
    };
    const adapted = adaptResponsesRequest(requestBody);
    const [namespaceTool, customTool] = adapted.tools!;
    const response = encodeResponsesResult({
      responseId: "resp_tools",
      createdAt: 1700000000,
      requestBody,
      result: {
        text: "",
        reasoning: "",
        toolCalls: [
          { index: 0, id: "call_ns", name: namespaceTool.name, arguments: '{"message":"inspect"}' },
          { index: 1, id: "call_custom", name: customTool.name, arguments: JSON.stringify({ input: "*** Begin Patch" }) },
        ],
        finishReason: "tool_calls",
      },
    });

    expect(response.output[0]).toMatchObject({
      type: "function_call",
      call_id: "call_ns",
      namespace: "multi_agent_v1",
      name: "spawn_agent",
      arguments: '{"message":"inspect"}',
    });
    expect(response.output[1]).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_custom",
      name: "apply_patch",
      input: "*** Begin Patch",
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
  const eventsFrom = async (chunks: any[], requestFields: Record<string, unknown> = {}) => {
    const source = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const text = await new Response(source.pipeThrough(createResponsesStreamEncoder({
      responseId: "resp_stream",
      model: "antigravity-gemini-3.8-flash",
      createdAt: 1700000000,
      requestBody: { model: "antigravity-gemini-3.8-flash", stream: true, ...requestFields },
    }))).text();
    return text.trim().split("\n\n").map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
  };

  test("serial streaming suppresses extra calls and preserves first-call deltas and usage", async () => {
    const events = await eventsFrom([
      { type: "chunk", chunk: { id: "resp_stream", created: 1, model: "m", toolCalls: [
        { index: 0, id: "sig:signature:call_a", name: "a", arguments: '{"enabled":' },
        { index: 1, id: "call_b", name: "b", arguments: "{}" },
      ] } },
      { type: "chunk", chunk: { id: "resp_stream", created: 1, model: "m", toolCalls: [
        { index: 2, id: "call_c", name: "c", arguments: "{}" },
        { index: 0, id: "sig:signature:call_a", name: "a", arguments: "true}" },
      ], finishReason: "tool_calls", usage: {
        inputTokens: 10, cachedInputTokens: null, outputTokens: 5, reasoningTokens: 2, reasoningTokensReported: true, totalTokens: 17,
      } } },
      { type: "done" },
    ], { parallel_tool_calls: false });
    const added = events.filter(event => event.type === "response.output_item.added");
    const done = events.filter(event => event.type === "response.output_item.done");
    expect(added).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(added[0].item.call_id).toBe("sig:signature:call_a");
    expect(done[0].item.arguments).toBe('{"enabled":true}');
    expect(events.filter(event => event.type === "response.function_call_arguments.delta").map(event => event.delta)).toEqual(['{"enabled":', "true}"]);
    const completed = events.at(-1);
    expect(completed.type).toBe("response.completed");
    expect(completed.response.parallel_tool_calls).toBe(false);
    expect(completed.response.output).toEqual([done[0].item]);
    expect(completed.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 7, total_tokens: 17 });
    expect(JSON.stringify(events)).not.toContain("call_b");
    expect(JSON.stringify(events)).not.toContain("call_c");
  });

  test("serial streaming also limits custom tools without changing their output shape", async () => {
    const adapted = adaptResponsesRequest({
      model: "antigravity-gemini-3.8-flash", input: "Patch",
      tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }],
    });
    const events = await eventsFrom([
      { type: "chunk", chunk: { id: "resp_stream", created: 1, model: "m", toolCalls: [
        { index: 0, id: "call_patch", name: adapted.tools![0].name, arguments: '{"input":"PATCH"}' },
        { index: 1, id: "call_extra", name: "b", arguments: "{}" },
      ], finishReason: "tool_calls" } },
      { type: "done" },
    ], { parallel_tool_calls: false });
    expect(events.at(-1).response.output).toHaveLength(1);
    expect(events.at(-1).response.output[0]).toMatchObject({ type: "custom_tool_call", name: "apply_patch", input: "PATCH" });
    expect(JSON.stringify(events)).not.toContain("call_extra");
  });

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

  test("streams a custom tool call using Responses custom_tool_call wire shape", async () => {
    const adapted = adaptResponsesRequest({
      model: "antigravity-gemini-3.8-flash",
      input: "Patch",
      tools: [{
        type: "custom",
        name: "apply_patch",
        description: "Patch",
        format: { type: "text", syntax: "plain", definition: "patch text" },
      }],
    });
    const customName = adapted.tools![0].name;
    const events = await eventsFrom([
      { type: "chunk", chunk: { id: "resp_stream", created: 1700000000, model: "m", toolCalls: [
        { index: 0, id: "call_patch", name: customName, arguments: JSON.stringify({ input: "PATCH-CONTENT" }) },
      ], finishReason: "tool_calls" } },
      { type: "done" },
    ]);

    const added = events.find(event => event.type === "response.output_item.added");
    expect(added.item).toMatchObject({ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch" });
    const done = events.find(event => event.type === "response.output_item.done");
    expect(done.item).toMatchObject({ type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "PATCH-CONTENT" });
    expect(events.some(event => event.type === "response.function_call_arguments.delta")).toBe(false);
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
