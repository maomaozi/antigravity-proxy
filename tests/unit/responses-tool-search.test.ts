import { beforeAll, describe, expect, test } from "bun:test";
import { loadProxyConfig } from "../../src/config/manager";
import { adaptResponsesRequest, createResponsesStreamEncoder, encodeResponsesResult, validateResponsesRequest } from "../../src/api/openai/responses";
import { transformCompletionToGoogleBody, transformGoogleEventToCompletionChunk } from "../../src/utils/transform";
import { accumulateCompletionChunks, type CompletionStreamEvent } from "../../src/core/completion";

beforeAll(loadProxyConfig);

const searchTool = {
  type: "tool_search", execution: "client", description: "Search deferred inventory tools using a query.",
  parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"], additionalProperties: false },
};
const lookup = { type: "function", name: "lookup", description: "Look up a SKU.", defer_loading: true, parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } };
const inventory = { type: "namespace", name: "inventory", description: "For every inventory tool, use the APAC snapshot.", tools: [lookup] };
const baseBody = { model: "antigravity-gemini-3.8-flash", input: [{ role: "user", content: "Look up SKU-123 in inventory." }], tools: [searchTool, inventory] };

function google(request: ReturnType<typeof adaptResponsesRequest>) {
  return transformCompletionToGoogleBody(request, "project", "", "session");
}

function responseForCall(name: string, args = { query: "inventory SKU lookup", limit: 1 }) {
  const chunk = transformGoogleEventToCompletionChunk({ response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "search-call", name, args }, thoughtSignature: "signed-search" }] }, finishReason: "STOP" }] } }, baseBody.model)!;
  const result = accumulateCompletionChunks([chunk]);
  return { chunk, result, response: encodeResponsesResult({ responseId: "resp_search", createdAt: 1, requestBody: baseBody, result }) };
}

describe("Responses namespace context", () => {
  test("keeps shared instructions once while preserving function/custom schemas and namespace identity", () => {
    const rules = "Use tenant APAC-741 and never modify records. ".repeat(40);
    const body = {
      model: baseBody.model, instructions: "Original system instructions.",
      input: [{ role: "developer", content: "Original developer instructions." }, { role: "user", content: "Use inventory." }],
      tools: [{ ...inventory, description: rules, tools: [{ ...lookup, defer_loading: false }, { type: "custom", name: "label", description: "Format a label.", format: { type: "grammar", syntax: "lark", definition: 'start: "LABEL"' } }] }, { ...inventory, name: "other", description: "Use tenant EMEA-852.", tools: [{ ...lookup, defer_loading: false }] }],
    };
    const upstream = google(adaptResponsesRequest(body)).request;
    const serialized = JSON.stringify(upstream);
    expect(serialized.split(rules.trim()).length - 1).toBe(1);
    expect(upstream.systemInstruction.parts[0].text).toContain("Original system instructions.\n\nOriginal developer instructions.");
    const declarations = upstream.tools[0].functionDeclarations;
    expect(declarations).toHaveLength(3);
    expect(new Set(declarations.map((tool: any) => tool.name)).size).toBe(3);
    expect(declarations[0].description).toContain("[Responses namespace: inventory]");
    expect(declarations[0].description).not.toContain("APAC-741");
    expect(declarations[0].parameters.properties.sku.type).toBe("STRING");
    expect(declarations[1].description).toContain(JSON.stringify({ type: "grammar", syntax: "lark", definition: 'start: "LABEL"' }));
    expect(upstream.contents).toEqual([{ role: "user", parts: [{ text: "Use inventory." }] }]);
  });

  test("does not add shared context for empty namespaces or blank descriptions", () => {
    const request = adaptResponsesRequest({ ...baseBody, tools: [{ ...inventory, tools: [] }, { ...inventory, description: "   ", tools: [{ ...lookup, defer_loading: false }] }] });
    expect(google(request).request.systemInstruction).toBeUndefined();
    expect(request.tools).toHaveLength(1);
  });
});

describe("Responses client tool search", () => {
  test("defers function and custom schemas and their namespace descriptions until loaded", () => {
    const body = { ...baseBody, tools: [searchTool, { ...inventory, tools: [lookup, { type: "custom", name: "label", description: "Format a label.", defer_loading: true }] }, { ...lookup, name: "top_level_lookup" }] };
    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request.tools).toHaveLength(1);
    const upstream = google(request).request;
    expect(upstream.systemInstruction).toBeUndefined();
    expect(JSON.stringify(upstream)).not.toContain("APAC snapshot");
    expect(upstream.tools[0].functionDeclarations[0].parameters.required).toEqual(["query"]);
    expect(upstream.tools[0].functionDeclarations[0].parameters.properties.limit.type).toBe("INTEGER");
  });

  test("round-trips search calls, loads returned schemas, and retains signed Google call correlation", () => {
    const request = adaptResponsesRequest(baseBody);
    const declaration = google(request).request.tools[0].functionDeclarations[0];
    const { response } = responseForCall(declaration.name);
    const searchCall = response.output[0];
    expect(searchCall).toMatchObject({ type: "tool_search_call", execution: "client", call_id: "sig:signed-search:search-call", status: "completed", arguments: { query: "inventory SKU lookup", limit: 1 } });
    expect(searchCall.name).toBeUndefined();
    const body = { ...baseBody, input: [...baseBody.input, ...response.output, { type: "tool_search_output", execution: "client", call_id: searchCall.call_id, status: "completed", tools: [inventory] }] };
    expect(validateResponsesRequest(body)).toBeUndefined();
    const loaded = adaptResponsesRequest(body);
    expect(loaded.tools).toHaveLength(2);
    const upstream = google(loaded).request;
    expect(upstream.systemInstruction.parts[0].text).toContain(inventory.description);
    expect(upstream.tools[0].functionDeclarations[1].parameters.properties.sku.type).toBe("STRING");
    expect(upstream.contents[1].parts[0]).toMatchObject({ functionCall: { id: "search-call", name: declaration.name, args: { query: "inventory SKU lookup", limit: 1 } }, thoughtSignature: "signed-search" });
    expect(upstream.contents[2].parts[0]).toEqual({ functionResponse: { id: "search-call", name: declaration.name, response: { tools: [{ name: "lookup", namespace: "inventory" }] } } });
    expect(JSON.stringify(upstream.contents[2])).not.toContain("properties");
    expect(inventory.tools[0].defer_loading).toBe(true);
  });

  test("loads additional_tools without converting developer metadata into an empty message", () => {
    const body = { ...baseBody, tools: [searchTool], input: [...baseBody.input, { type: "additional_tools", role: "developer", tools: [inventory] }, { type: "additional_tools", role: "developer", tools: [inventory] }] };
    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request.tools).toHaveLength(2);
    expect(google(request).request.contents).toHaveLength(1);
    expect(JSON.stringify(google(request).request).split(inventory.description).length - 1).toBe(1);
  });

  test("accepts client search introduced by developer additional_tools", () => {
    const body = { ...baseBody, tools: [inventory], input: [...baseBody.input, { type: "additional_tools", role: "developer", tools: [searchTool] }] };
    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request.tools).toHaveLength(1);
    expect(request.tools![0].description).toBe(searchTool.description);
    expect(google(request).request.systemInstruction).toBeUndefined();
  });

  test("accumulates discovered tools across turns without loading the rest of a deferred namespace", () => {
    const other = { ...lookup, name: "inspect", description: "Inspect a SKU." };
    const calls = ["first", "second"].flatMap((id, i) => [
      { type: "tool_search_call", execution: "client", call_id: id, arguments: { query: i ? "inspect" : "lookup" } },
      { type: "tool_search_output", execution: "client", call_id: id, status: "completed", tools: [{ ...inventory, tools: [i ? other : lookup] }] },
    ]);
    const body = { ...baseBody, tools: [searchTool, { ...inventory, tools: [lookup, other, { ...lookup, name: "unused" }] }], input: [...baseBody.input, ...calls] };
    expect(validateResponsesRequest(body)).toBeUndefined();
    const request = adaptResponsesRequest(body);
    expect(request.tools).toHaveLength(3);
    const upstream = google(request).request;
    expect(JSON.stringify(upstream).split(inventory.description).length - 1).toBe(1);
    expect(upstream.contents).toHaveLength(5);
    expect(JSON.stringify(upstream)).not.toContain("unused");
  });

  test("distinguishes an ordinary function named tool_search from the client search builtin", () => {
    const request = adaptResponsesRequest({ ...baseBody, tools: [searchTool, { ...lookup, name: "tool_search", defer_loading: false }] });
    expect(request.tools).toHaveLength(2);
    const result = { text: "", reasoning: "", toolCalls: [{ index: 0, id: "ordinary", name: "tool_search", arguments: '{"sku":"123"}' }], finishReason: "tool_calls" as const };
    expect(encodeResponsesResult({ responseId: "resp_ordinary", createdAt: 1, requestBody: baseBody, result }).output[0]).toMatchObject({ type: "function_call", name: "tool_search", arguments: '{"sku":"123"}' });
  });

  test("supports loaded custom tools absent from the initial tools array", () => {
    const request = adaptResponsesRequest({ ...baseBody, input: [...baseBody.input, { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "labels", description: "Use plain label text.", tools: [{ type: "custom", name: "format", description: "Format label text.", defer_loading: true, format: { type: "text" } }] }] }] });
    expect(request.tools).toHaveLength(2);
    const loadedTool = request.tools![1];
    const result = { text: "", reasoning: "", toolCalls: [{ index: 0, id: "label-call", name: loadedTool.name, arguments: '{"input":"LABEL:123"}' }], finishReason: "tool_calls" as const };
    expect(encodeResponsesResult({ responseId: "resp_label", createdAt: 1, requestBody: baseBody, result }).output[0]).toMatchObject({ type: "custom_tool_call", namespace: "labels", name: "format", input: "LABEL:123" });
  });

  test("retains eager loading when no search tool was declared", () => {
    expect(adaptResponsesRequest({ ...baseBody, tools: [inventory] }).tools).toHaveLength(1);
  });

  test("streams typed search items and object arguments without function-call argument events", async () => {
    const name = google(adaptResponsesRequest(baseBody)).request.tools[0].functionDeclarations[0].name;
    const { chunk } = responseForCall(name);
    const source = new ReadableStream<CompletionStreamEvent>({ start(controller) { controller.enqueue({ type: "chunk", chunk }); controller.enqueue({ type: "done" }); controller.close(); } });
    const text = await new Response(source.pipeThrough(createResponsesStreamEncoder({ responseId: "resp_search", model: baseBody.model, createdAt: 1, requestBody: { ...baseBody, stream: true } }))).text();
    const events = text.trim().split("\n\n").map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
    expect(events.find(e => e.type === "response.output_item.added").item).toMatchObject({ type: "tool_search_call", execution: "client", arguments: {}, status: "in_progress" });
    const done = events.find(e => e.type === "response.output_item.done").item;
    expect(done.arguments).toEqual({ query: "inventory SKU lookup", limit: 1 });
    expect(events.at(-1).response.output).toEqual([done]);
    expect(events.some(e => e.type.startsWith("response.function_call_arguments"))).toBe(false);
  });

  test("rejects server search and malformed client declarations/history before contacting Google", () => {
    for (const tool of [{ type: "tool_search" }, { ...searchTool, execution: "server" }, { ...searchTool, description: "" }, { ...searchTool, parameters: [] }]) {
      expect(validateResponsesRequest({ ...baseBody, tools: [tool] })).toBeDefined();
    }
    for (const item of [
      { type: "tool_search_call", execution: "client", call_id: "c", arguments: "{}" },
      { type: "tool_search_call", execution: "client", call_id: "", arguments: {} },
      { type: "tool_search_output", execution: "server", call_id: "c", tools: [] },
      { type: "tool_search_output", execution: "client", call_id: "c", tools: [{ type: "web_search" }] },
      { type: "additional_tools", role: "user", tools: [lookup] },
      { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "x", tools: [{ type: "function", name: "" }] }] },
    ]) expect(validateResponsesRequest({ ...baseBody, input: [...baseBody.input, item] })).toBeDefined();
  });
});
