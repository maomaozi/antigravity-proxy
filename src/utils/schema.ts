// Fields accepted by Google's `Schema` message. FunctionDeclaration.parameters
// and GenerationConfig.responseSchema do not accept arbitrary JSON Schema.
const SIMPLE_SCHEMA_FIELDS = new Set([
  "title",
  "description",
  "format",
  "default",
  "enum",
  "nullable",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "propertyOrdering",
  "example",
]);

function resolveLocalRef(root: any, ref: string): any | undefined {
  if (!ref.startsWith("#/")) return undefined;

  let current = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function cleanSchema(schema: any, root: any, aggressive: boolean, refs: Set<string>): any {
  if (schema === true) return { type: "STRING" };
  if (schema === false) return { type: "NULL" };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalRef(root, schema.$ref);
    if (!resolved || refs.has(schema.$ref)) return { type: "OBJECT" };

    const nextRefs = new Set(refs).add(schema.$ref);
    const siblings = Object.fromEntries(
      Object.entries(schema).filter(([key]) => key !== "$ref" && !key.startsWith("$"))
    );
    return cleanSchema({ ...resolved, ...siblings }, root, aggressive, nextRefs);
  }

  const unionOptions = schema.anyOf || schema.oneOf;
  if (aggressive && Array.isArray(unionOptions)) {
    const bestOption = unionOptions.find((option: any) => option?.type === "object")
      || unionOptions.find((option: any) => option?.type !== "null")
      || unionOptions[0];
    return cleanSchema(bestOption, root, aggressive, refs);
  }

  const result: any = {};
  const propertyNames = new Set<string>(
    schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties)
      : []
  );

  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      if (typeof value === "string") {
        result.type = value.toUpperCase();
      } else if (Array.isArray(value)) {
        const concreteTypes = value.filter(type => type !== "null");
        if (concreteTypes.length === 1 && typeof concreteTypes[0] === "string") {
          result.type = concreteTypes[0].toUpperCase();
          result.nullable = value.includes("null");
        } else if (!aggressive) {
          result.anyOf = value.map(type => ({ type: String(type).toUpperCase() }));
        }
      }
    } else if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      result.properties = Object.fromEntries(
        Object.entries(value).map(([name, propertySchema]) => [
          name,
          cleanSchema(propertySchema, root, aggressive, refs)
        ])
      );
    } else if (key === "items" && value && typeof value === "object") {
      result.items = cleanSchema(value, root, aggressive, refs);
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value) && !aggressive) {
      // Google's Schema supports anyOf, but not oneOf.
      result.anyOf = value.map(option => cleanSchema(option, root, aggressive, refs));
    } else if (key === "const" && !aggressive) {
      result.enum = [value];
    } else if (key === "examples" && Array.isArray(value) && value.length > 0 && !aggressive) {
      result.example = value[0];
    } else if (key === "required" && Array.isArray(value) && propertyNames.size > 0) {
      const validRequired = value.filter(name => typeof name === "string" && propertyNames.has(name));
      if (validRequired.length > 0) result.required = validRequired;
    } else if (SIMPLE_SCHEMA_FIELDS.has(key) && (!aggressive || key === "enum" || key === "format")) {
      result[key] = value;
    }
  }

  if (Array.isArray(result.enum)) {
    if (result.enum.length === 0) {
      delete result.enum;
    } else if (result.enum.every((value: any) => typeof value === "string" || typeof value === "number")) {
      // Google's Schema encodes even numeric enum values as strings. Keep the
      // declared type so tool arguments remain numbers rather than strings.
      result.enum = result.enum.map(String);
    } else {
      // Boolean, null, and structured enums cannot be represented by Google's
      // string/number enum schema. Preserve the constraint as model guidance
      // without changing the argument type or sending an invalid enum payload.
      const guidance = `Allowed values: ${result.enum.map((value: any) => JSON.stringify(value)).join(", ")}.`;
      result.description = [result.description, guidance].filter(Boolean).join(" ");
      delete result.enum;
    }
  }

  if (result.type === "ARRAY" && !result.items) result.items = { type: "STRING" };
  if (!result.type && schema.properties) result.type = "OBJECT";
  return result;
}

export function cleanJSONSchemaForAntigravity(schema: any, aggressive: boolean = false): any {
  return cleanSchema(schema, schema, aggressive, new Set());
}
