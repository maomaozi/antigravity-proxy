import { beforeAll, describe, expect, test } from "bun:test";
import { ClaudeToolSchemaError, normalizeClaudeToolSchema, toClaudeJSONSchema } from "../../src/utils/claude-schema";
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

// Reduced capture_browser_scenario shape: nested discriminated object unions,
// action arrays, and scalar constraints must reach Claude without Google Schema.
const browserSchema = {
  type: "object", additionalProperties: false,
  properties: {
    browser: { oneOf: [
      { type: "object", properties: { mode: { const: "launch" }, executable_path: { type: "string" } }, required: ["mode", "executable_path"], additionalProperties: false },
      { type: "object", properties: { mode: { const: "connect" }, target_id: { type: "string" } }, required: ["mode", "target_id"], additionalProperties: false },
    ] },
    actions: { type: "array", minItems: 1, items: { oneOf: [
      { type: "object", properties: { action: { const: "click" }, count: { type: "integer", enum: [1, 2] } }, required: ["action", "count"] },
      { type: "object", properties: { action: { const: "fill" }, value: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["action", "value"] },
    ] } },
    enabled: { type: "boolean", enum: [true, false] },
    value: { anyOf: [{ type: "string" }, { type: "integer" }] },
  }, required: ["browser", "actions"],
};

describe("Claude native parameter JSON Schema", () => {
  test("preserves nested unions, closed objects, literal enums, and scalar types on retries", () => {
    const original = structuredClone(browserSchema);
    for (const aggressive of [false, true]) {
      const tool = transformCompletionToGoogleBody(request(browserSchema), "p", "", "s", aggressive).request.tools[0].functionDeclarations[0];
      expect(tool.parameters).toBeUndefined();
      expect(tool.parametersJsonSchema).toEqual(original);
    }
    expect(browserSchema).toEqual(original);
    const gemini = transformCompletionToGoogleBody(request(browserSchema, "antigravity-gemini-3.8-flash"), "p", "", "s").request.tools[0].functionDeclarations[0];
    expect(gemini.parametersJsonSchema).toBeUndefined();
    expect(gemini.parameters.properties.browser.anyOf).toHaveLength(2);
  });

  test("uses native schemas for Responses namespace tools loaded after client search", () => {
    const body = { model: "antigravity-claude-sonnet-5-5", input: [{ role: "user", content: "Capture the page." }, { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "mcp__rea", tools: [{ type: "function", name: "capture_browser_scenario", parameters: browserSchema }] }] }] };
    const adapted = adaptResponsesRequest(body);
    expect(validateCompletionRequestForGoogle(adapted)).toBeUndefined();
    const tool = transformCompletionToGoogleBody(adapted, "p", "", "s").request.tools[0].functionDeclarations[0];
    expect(tool.parameters).toBeUndefined();
    expect(tool.parametersJsonSchema).toEqual(browserSchema);
    expect(adapted.tools![0]!.parameters).toEqual(browserSchema);
  });

  test("preserves recursive definitions and references on the native path", () => {
    const schema = { type: "object", properties: { tree: { $ref: "#/$defs/node" } }, $defs: { node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } } } } };
    const tool = transformCompletionToGoogleBody(request(schema), "p", "", "s").request.tools[0].functionDeclarations[0];
    expect(tool.parametersJsonSchema).toEqual(schema);
  });

  test("upgrades tuple schemas and their references without modifying literal data or property names", () => {
    const literal = { items: [{ type: "string" }], additionalItems: false, $ref: "#/$defs/pair/items/0" };
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#", type: "object",
      properties: {
        pair: { $ref: "#/$defs/pair" }, first: { $ref: "#/$defs/pair/items/0" }, tail: { $ref: "#/$defs/pair/additionalItems" },
        items: { type: "string" }, additionalItems: { type: "boolean" },
        payload: { type: "object", default: literal, const: literal, enum: [literal] },
        literalReference: { $ref: "#/properties/payload/default/items/0" },
        variants: { anyOf: [{ type: "array", items: [{ type: "boolean" }] }, { type: "array", items: [], additionalItems: false }] },
      },
      $defs: { pair: { type: "array", items: [{ type: "string" }, { type: "integer" }], additionalItems: false, minItems: 2, maxItems: 2 } },
    };
    const original = structuredClone(schema);
    const result = toClaudeJSONSchema(schema);
    expect(result.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(result.$defs.pair).toEqual({ type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: false, minItems: 2, maxItems: 2 });
    expect(result.properties.first.$ref).toBe("#/$defs/pair/prefixItems/0");
    expect(result.properties.tail.$ref).toBe("#/$defs/pair/items");
    expect(result.properties.items).toEqual(schema.properties.items);
    expect(result.properties.additionalItems).toEqual(schema.properties.additionalItems);
    expect(result.properties.payload).toEqual(schema.properties.payload);
    expect(result.properties.literalReference).toEqual(schema.properties.literalReference);
    expect(result.properties.variants.anyOf).toEqual([
      { type: "array", prefixItems: [{ type: "boolean" }], items: true },
      { type: "array", items: false },
    ]);
    expect(schema).toEqual(original);
  });

  test("retains 2020-12 prefixItems and boolean schemas", () => {
    const schema = { type: "object", properties: { tuple: { type: "array", prefixItems: [true, false], items: false }, anything: true, nothing: false }, additionalProperties: false };
    expect(toClaudeJSONSchema(schema)).toEqual(schema);
  });

  test("rewrites nested tuple pointers with escaped names and local schema IDs", () => {
    const schema = { type: "object", $defs: {
      "a/b~c": { type: "array", items: [{ type: "array", items: [{ type: "string" }] }] },
      local: { $id: "https://example.test/local", type: "array", items: [{ type: "integer" }], $defs: { first: { $ref: "#/items/0" } } },
    }, properties: { first: { $ref: "#/$defs/a~1b~0c/items/0/items/0" } } };
    const result = toClaudeJSONSchema(schema);
    expect(result.properties.first.$ref).toBe("#/$defs/a~1b~0c/prefixItems/0/prefixItems/0");
    expect(result.$defs.local.$defs.first.$ref).toBe("#/prefixItems/0");
  });
});

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
      expect(tool.parameters).toBeUndefined();
      expect(tool.parametersJsonSchema.type).toBe("object");
      expect(tool.parametersJsonSchema.oneOf).toBeUndefined();
      expect(tool.parametersJsonSchema.anyOf).toBeUndefined();
      expect(tool.parametersJsonSchema.properties.mode).toEqual({ type: "string", enum: ["path", "url"] });
      expect(tool.description).toContain("Satisfy exactly one parameter group");
    }
    const gemini = transformCompletionToGoogleBody(request(variants, "antigravity-gemini-3.8-flash"), "p", "", "s").request.tools[0].functionDeclarations[0];
    expect(gemini.parameters.anyOf).toHaveLength(2);
    expect(gemini.description).not.toContain("parameter group");
    const body = { model: "antigravity-claude-opus-5-5", input: [{ role: "user", content: "Use lookup." }, { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "inventory", tools: [{ type: "function", name: "lookup", parameters: variants }] }] }] };
    const adapted = adaptResponsesRequest(body);
    expect(validateCompletionRequestForGoogle(adapted)).toBeUndefined();
    expect(transformCompletionToGoogleBody(adapted, "p", "", "s").request.tools[0].functionDeclarations[0].parametersJsonSchema.properties.url.type).toBe("string");
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
