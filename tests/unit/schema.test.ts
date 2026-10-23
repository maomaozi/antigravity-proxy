import { describe, expect, test } from "bun:test";
import { cleanJSONSchemaForAntigravity } from "../../src/utils/schema";

describe("Google Schema enum compatibility", () => {
  for (const aggressive of [false, true]) {
    test(`normalizes nested enum values without changing argument types (aggressive=${aggressive})`, () => {
      const schema = {
        type: "object",
        $defs: { enabled: { type: "boolean", enum: [true] } },
        properties: {
          enabled: { $ref: "#/$defs/enabled" },
          flags: { type: "array", items: { type: "boolean", enum: [true, false] } },
          count: { type: "integer", enum: [1, 2] },
          ratio: { type: "number", enum: [0.5, 1] },
          mode: { type: "string", enum: ["auto", "manual"] },
        },
      };
      const original = structuredClone(schema);
      const result = cleanJSONSchemaForAntigravity(schema, aggressive);

      expect(result.properties.enabled).toEqual({ type: "BOOLEAN", description: "Allowed values: true." });
      expect(result.properties.flags.items).toEqual({ type: "BOOLEAN", description: "Allowed values: true, false." });
      expect(result.properties.count).toEqual({ type: "INTEGER", enum: ["1", "2"] });
      expect(result.properties.ratio).toEqual({ type: "NUMBER", enum: ["0.5", "1"] });
      expect(result.properties.mode).toEqual({ type: "STRING", enum: ["auto", "manual"] });
      expect(schema).toEqual(original);
    });
  }

  test("normalizes enums generated from const and preserves existing descriptions", () => {
    expect(cleanJSONSchemaForAntigravity({ type: "boolean", const: false, description: "Disable it." })).toEqual({
      type: "BOOLEAN", description: "Disable it. Allowed values: false.",
    });
    expect(cleanJSONSchemaForAntigravity({ type: "integer", const: 3 })).toEqual({ type: "INTEGER", enum: ["3"] });
    expect(cleanJSONSchemaForAntigravity({ type: "string", const: "ok" })).toEqual({ type: "STRING", enum: ["ok"] });
  });

  test("handles enums inside union branches and removes empty enums", () => {
    expect(cleanJSONSchemaForAntigravity({ anyOf: [
      { type: "boolean", enum: [true] },
      { type: "null", enum: [null] },
    ] })).toEqual({ anyOf: [
      { type: "BOOLEAN", description: "Allowed values: true." },
      { type: "NULL", description: "Allowed values: null." },
    ] });
    expect(cleanJSONSchemaForAntigravity({ type: "string", enum: [] })).toEqual({ type: "STRING" });
  });
});
