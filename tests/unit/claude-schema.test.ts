import { beforeAll, describe, expect, test } from "bun:test";
import { ClaudeToolSchemaError, normalizeClaudeToolSchema } from "../../src/utils/claude-schema";
import { cleanJSONSchemaForAntigravity } from "../../src/utils/schema";
import { loadProxyConfig } from "../../src/config/manager";
import { adaptResponsesRequest, createResponsesStreamEncoder, encodeResponsesResult } from "../../src/api/openai/responses";
import { transformCompletionToGoogleBody, transformGoogleEventToCompletionChunk, validateCompletionRequestForGoogle } from "../../src/utils/transform";
import { accumulateCompletionChunks, type CompletionRequest, type CompletionStreamEvent } from "../../src/core/completion";

beforeAll(loadProxyConfig);

const variants = {
  type: "object", description: "Choose a lookup method.",
  properties: { tenant: { type: "string" } }, required: ["tenant"],
  oneOf: [
    { type: "object", properties: { mode: { type: "string", const: "path" }, path: { type: "string" } }, required: ["mode", "path"] },
    { type: "object", properties: { mode: { type: "string", const: "url" }, url: { type: "string" } }, required: ["mode", "url"] },
  ],
};
const request = (schema: any, model = "antigravity-claude-sonnet-5-5"): CompletionRequest => ({ model, messages: [{ role: "user", content: "Look up the URL." }], tools: [{ name: "lookup", description: "Look up an item.", parameters: schema }], stream: false });

describe("Claude tool root schema normalization", () => {
  test("keeps every union branch, parent requirements, shared requirements, and discriminator guidance", () => {
    const original = structuredClone(variants);
    const result = normalizeClaudeToolSchema(variants, "lookup");
    expect(result.schema.type).toBe("object");
    expect(result.schema.oneOf).toBeUndefined();
    expect(Object.keys(result.schema.properties)).toEqual(["tenant", "mode", "path", "url"]);
    expect(result.schema.required).toEqual(["tenant", "mode"]);
    expect(result.schema.properties.mode).toEqual({ type: "string", enum: ["path", "url"] });
    expect(result.guidance).toContain("Satisfy exactly one parameter group (oneOf)");
    expect(result.guidance).toContain('"required":["mode","url"]');
    expect(result.guidance).toContain('"const":"path"');
    expect(variants).toEqual(original);
  });

  test("supports required-only alternatives without making both parameter groups mandatory", () => {
    const schema = { type: "object", properties: { path: { type: "string" }, url: { type: "string" } }, anyOf: [{ required: ["path"] }, { required: ["url"] }] };
    const result = normalizeClaudeToolSchema(schema, "lookup");
    expect(result.schema.properties).toEqual(schema.properties);
    expect(result.schema.required).toBeUndefined();
    expect(result.guidance).toContain("Satisfy at least one parameter group (anyOf)");
    expect(result.guidance).toContain('"required":["path"]');
  });

  test("merges allOf constraints with intersections rather than overwriting shared fields", () => {
    const schema = { allOf: [
      { type: "object", properties: { count: { type: "number", minimum: 1, maximum: 20, enum: [1, 2, 3] }, left: { type: "string" } }, required: ["left"] },
      { type: "object", properties: { count: { type: "integer", minimum: 2, maximum: 10, enum: [2, 3, 4] }, right: { type: "string" } }, required: ["right", "count"] },
    ] };
    const result = normalizeClaudeToolSchema(schema, "combine").schema;
    expect(result.allOf).toBeUndefined();
    expect(result.required).toEqual(["left", "right", "count"]);
    expect(result.properties.count).toEqual({ type: "integer", minimum: 2, maximum: 10, enum: [2, 3] });
    expect(cleanJSONSchemaForAntigravity(result).properties.count.enum).toEqual(["2", "3"]);
  });

  test("intersects nested object and array constraints and const with enum", () => {
    const result = normalizeClaudeToolSchema({ allOf: [
      { properties: { values: { type: "array", minItems: 1, items: { type: "integer", minimum: 0 } }, options: { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } } } },
      { properties: { values: { type: "array", maxItems: 3, items: { type: "integer", maximum: 9 } }, options: { type: "object", properties: { mode: { const: "b" } }, required: ["mode"] } } },
    ] }, "combine").schema;
    expect(result.properties.values).toEqual({ type: "array", minItems: 1, maxItems: 3, items: { type: "integer", minimum: 0, maximum: 9 } });
    expect(result.properties.options.required).toEqual(["mode"]);
    expect(result.properties.options.properties.mode).toEqual({ type: "string", enum: ["b"] });
  });

  test("uses typed property envelopes for all union variants, including nested objects and arrays", () => {
    const branches = ["a", "b", "c"].map((mode, i) => ({ properties: {
      mode: { const: mode }, count: { type: i === 0 ? "number" : "integer", minimum: i, maximum: i + 5 },
      options: { type: "object", properties: { mode: { type: "string", const: mode }, [mode]: { type: "string" } }, required: ["mode", mode] },
      values: { type: "array", minItems: i, items: { type: "string", enum: [mode] } },
    } }));
    const result = normalizeClaudeToolSchema({ anyOf: branches }, "variants").schema;
    expect(result.properties.mode).toEqual({ type: "string", enum: ["a", "b", "c"] });
    expect(result.properties.count).toEqual({ type: "number", minimum: 0, maximum: 7 });
    expect(Object.keys(result.properties.options.properties)).toEqual(["mode", "a", "b", "c"]);
    expect(result.properties.options.required).toEqual(["mode"]);
    expect(result.properties.values).toEqual({ type: "array", minItems: 0, items: { type: "string", enum: ["a", "b", "c"] } });
    expect(JSON.stringify(result)).not.toContain("anyOf");
  });

  test("preserves nested unions, literal values, and properties whose names match schema keywords", () => {
    const literal = { $ref: "not-a-reference", description: "literal data", definitions: "literal" };
    const schema = { anyOf: [{ properties: {
      description: { type: "string" }, definitions: { type: "string" }, $ref: { type: "string" },
      choice: { anyOf: [{ type: "string" }, { type: "integer" }] },
      payload: { enum: [literal] },
    }, required: ["description", "definitions", "$ref"] }] };
    const result = normalizeClaudeToolSchema(schema, "keywords");
    expect(result.schema.properties.payload.enum).toEqual([literal]);
    expect(result.schema.properties.choice).toEqual(schema.anyOf[0].properties.choice);
    expect(result.guidance).toContain('"description":{"type":"string"}');
    expect(result.guidance).toContain('"$ref":"not-a-reference"');
    expect(result.schema.properties.$ref).toEqual({ type: "string" });
  });

  test("resolves root and branch local references without mutating definitions", () => {
    const schema = { $ref: "#/$defs/input", $defs: {
      input: { anyOf: [{ $ref: "#/$defs/a~1b" }, { type: "object", properties: { url: { $ref: "#/$defs/text" } }, required: ["url"] }] },
      "a/b": { type: "object", properties: { path: { $ref: "#/$defs/text" } }, required: ["path"] }, text: { type: "string", minLength: 1 },
    } };
    const original = structuredClone(schema);
    const result = normalizeClaudeToolSchema(schema, "references");
    expect(result.schema.properties.path).toEqual({ type: "string", minLength: 1 });
    expect(result.schema.properties.url).toEqual({ type: "string", minLength: 1 });
    expect(JSON.stringify(result)).not.toContain('"$ref"');
    expect(schema).toEqual(original);
  });

  test("normalizes combined root operators and retains the rules of nested alternatives", () => {
    const schema = { allOf: [
      { properties: { tenant: { type: "string" } }, required: ["tenant"] },
      { oneOf: [{ properties: { path: { type: "string" } }, required: ["path"] }, { properties: { url: { type: "string" } }, required: ["url"] }] },
    ], anyOf: [{ required: ["tenant"] }] };
    const result = normalizeClaudeToolSchema(schema, "combined");
    expect(Object.keys(result.schema.properties)).toEqual(["tenant", "path", "url"]);
    expect(result.schema.required).toEqual(["tenant"]);
    expect(result.guidance).toContain('"oneOf"');
    expect(result.guidance).toContain('"required":["url"]');
  });

  test("leaves ordinary schemas and their nested unions on the existing path", () => {
    const schema = { type: "object", properties: { value: { oneOf: [{ type: "string" }, { type: "integer" }] } } };
    const result = normalizeClaudeToolSchema(schema, "plain");
    expect(result.schema).toBe(schema);
    expect(result.guidance).toBe("");
  });

  test("reports the tool and conflict instead of discarding unsupported constraints or branches", () => {
    const schemas = [
      { allOf: [{ properties: { x: { type: "string" } } }, { properties: { x: { type: "integer" } } }] },
      { allOf: [{ properties: { x: { enum: ["a"] } } }, { properties: { x: { const: "b" } } }] },
      { allOf: [{ properties: { x: { minimum: 5 } } }, { properties: { x: { maximum: 2 } } }] },
      { allOf: [{ properties: { x: { pattern: "^a" } } }, { properties: { x: { pattern: "z$" } } }] },
      { allOf: [{ properties: { a: { type: "string" } }, additionalProperties: false }, { properties: { b: { type: "string" } }, additionalProperties: false }] },
      { allOf: [{ additionalProperties: false }, { properties: { a: { type: "string" } }, required: ["a"] }] },
      { allOf: [{ properties: { x: { anyOf: [{ type: "string" }, { type: "integer" }] } } }, { properties: { x: { type: "string" } } }] },
      { anyOf: [{ type: "string" }, { type: "object" }] },
      { anyOf: [{ properties: { x: { type: "string" } } }, { properties: { x: { type: "integer" } } }] },
      { anyOf: [] },
      { anyOf: [{ $ref: "#/$defs/missing" }] },
      { anyOf: [{ type: "object", not: { required: ["x"] } }] },
      { anyOf: [{ $ref: "#/$defs/loop" }], $defs: { loop: { $ref: "#/$defs/loop" } } },
    ];
    for (const schema of schemas) {
      expect(() => normalizeClaudeToolSchema(schema, "broken_tool")).toThrow(ClaudeToolSchemaError);
      expect(validateCompletionRequestForGoogle(request(schema))).toContain('"lookup"');
    }
  });
});

describe("Claude schema integration", () => {
  test("applies normalization to Chat and Responses, including newly discovered tools, without changing Gemini", () => {
    for (const aggressive of [false, true]) {
      const upstream = transformCompletionToGoogleBody(request(variants), "p", "", "s", aggressive).request;
      const tool = upstream.tools[0].functionDeclarations[0];
      expect(tool.parameters.type).toBe("OBJECT");
      expect(tool.parameters.oneOf).toBeUndefined();
      expect(tool.parameters.anyOf).toBeUndefined();
      expect(tool.parameters.properties.mode).toEqual({ type: "STRING", enum: ["path", "url"] });
      expect(tool.description).toContain("Satisfy exactly one parameter group");
    }
    const gemini = transformCompletionToGoogleBody(request(variants, "antigravity-gemini-3.8-flash"), "p", "", "s").request.tools[0].functionDeclarations[0];
    expect(gemini.parameters.anyOf).toHaveLength(2);
    expect(gemini.description).not.toContain("parameter group");
    const body = { model: "antigravity-claude-opus-5-5", input: [{ role: "user", content: "Use lookup." }, { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "inventory", tools: [{ type: "function", name: "lookup", parameters: variants }] }] }] };
    const adapted = adaptResponsesRequest(body);
    expect(validateCompletionRequestForGoogle(adapted)).toBeUndefined();
    expect(transformCompletionToGoogleBody(adapted, "p", "", "s").request.tools[0].functionDeclarations[0].parameters.properties.url.type).toBe("STRING");
  });

  test("keeps flat arguments and namespace identity through JSON, SSE, and tool-result history", async () => {
    const body = { model: "antigravity-claude-sonnet-5-5", input: [{ role: "user", content: "Use the URL lookup." }], tools: [{ type: "namespace", name: "inventory", tools: [{ type: "function", name: "lookup", parameters: variants }] }] };
    const upstream = transformCompletionToGoogleBody(adaptResponsesRequest(body), "p", "", "s").request;
    const args = { tenant: "APAC", mode: "url", url: "https://example.test/item" };
    const chunk = transformGoogleEventToCompletionChunk({ response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "call_lookup", name: upstream.tools[0].functionDeclarations[0].name, args } }] }, finishReason: "STOP" }] } }, body.model)!;
    const result = accumulateCompletionChunks([chunk]);
    const context = { responseId: "resp_lookup", model: body.model, createdAt: 1, requestBody: body };
    const response = encodeResponsesResult({ ...context, result });
    expect(response.output[0]).toMatchObject({ type: "function_call", namespace: "inventory", name: "lookup", arguments: JSON.stringify(args) });
    const source = new ReadableStream<CompletionStreamEvent>({ start(controller) { controller.enqueue({ type: "chunk", chunk }); controller.enqueue({ type: "done" }); controller.close(); } });
    const text = await new Response(source.pipeThrough(createResponsesStreamEncoder(context))).text();
    const events = text.trim().split("\n\n").map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: "))!.slice(6)));
    expect(events.at(-1).response.output).toEqual(response.output);
    const followup = adaptResponsesRequest({ ...body, input: [...body.input, ...response.output, { type: "function_call_output", call_id: "call_lookup", output: "found" }] });
    expect(validateCompletionRequestForGoogle(followup)).toBeUndefined();
    expect(transformCompletionToGoogleBody(followup, "p", "", "s").request.contents[1].parts[0].functionCall.args).toEqual(args);
  });
});
