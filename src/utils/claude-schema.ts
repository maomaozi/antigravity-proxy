import { isDeepStrictEqual } from "node:util";

type Schema = Record<string, any>;
const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;
const ROOT_FIELDS = new Set([
  "type", "properties", "required", "additionalProperties", "minProperties", "maxProperties",
  "description", "title", "default", "examples", "example", "$schema", "$id", "$comment",
]);

/** Upgrade draft-7 tuple syntax for Claude's draft 2020-12 schema validator.
 * Visit schema positions only: defaults, consts, and enum values are literal data.
 */
export function toClaudeJSONSchema(schema: any): any {
  const object = (value: any): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const singles = new Set(["items", "additionalItems", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "contains", "not", "if", "then", "else", "contentSchema"]);
  const tuplePaths = new Set<string>();
  const references: { node: Schema; ref: string; scope: string }[] = [];
  const escape = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
  const rewriteRef = (ref: string, scope: string): string => {
    if (!ref.startsWith("#/")) return ref;
    let path = scope;
    const parts = ref.slice(2).split("/").map(key => {
      const rewritten = tuplePaths.has(path) && key === "items" ? "prefixItems"
        : tuplePaths.has(path) && key === "additionalItems" ? "items" : key;
      path += `/${key}`;
      return rewritten;
    });
    return `#/${parts.join("/")}`;
  };
  const visit = (node: any, path: string = "#", scope: string = "#"): any => {
    if (!object(node)) return node;
    const result: Schema = Object.create(null);
    const tuple = Array.isArray(node.items);
    if (tuple) tuplePaths.add(path);
    if (typeof node.$id === "string") scope = path;
    for (const [key, value] of Object.entries(node)) {
      if (tuple && (key === "items" || key === "additionalItems")) continue;
      const childPath = `${path}/${key}`;
      if (maps.has(key) && object(value)) result[key] = Object.fromEntries(Object.entries(value).map(([name, part]) => [name, visit(part, `${childPath}/${escape(name)}`, scope)]));
      else if (arrays.has(key) && Array.isArray(value)) result[key] = value.map((part, index) => visit(part, `${childPath}/${index}`, scope));
      else if (singles.has(key)) result[key] = visit(value, childPath, scope);
      else result[key] = value;
    }
    if (typeof node.$ref === "string") references.push({ node: result, ref: node.$ref, scope });
    if (tuple) {
      if (node.items.length) result.prefixItems = node.items.map((part: any, index: number) => visit(part, `${path}/items/${index}`, scope));
      result.items = visit(node.additionalItems ?? true, `${path}/additionalItems`, scope);
    }
    // The output uses 2020-12 tuple syntax even when the client advertised draft-7.
    if (typeof result.$schema === "string" && /draft[-/]07/.test(result.$schema)) result.$schema = "https://json-schema.org/draft/2020-12/schema";
    return result;
  };
  const result = visit(schema);
  for (const { node, ref, scope } of references) node.$ref = rewriteRef(ref, scope);
  return result;
}

export class ClaudeToolSchemaError extends Error {
  constructor(toolName: string, detail: string) {
    super(`Claude tool ${JSON.stringify(toolName)} has an unsupported input schema: ${detail}`);
    this.name = "ClaudeToolSchemaError";
  }
}

/** Keep the client's flat argument shape, following Claude Code's root-union rewrite.
 * Union correlations become model guidance; the tool executor must still validate
 * arguments against the original schema. Never select just one union branch.
 */
export function normalizeClaudeToolSchema(schema: any, toolName: string): { schema: any; guidance: string } {
  const fail = (detail: string): never => { throw new ClaudeToolSchemaError(toolName, detail); };
  const object = (value: any): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);
  const unique = (values: any[]): any[] => values.filter((value, i) => !values.slice(0, i).some(other => isDeepStrictEqual(value, other)));

  const resolve = (ref: string): any => {
    if (!ref.startsWith("#/")) return fail(`only local references can be normalized (${ref}).`);
    let value = schema;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return fail(`unresolved reference ${ref}.`);
      value = (value as any)[key];
    }
    return value;
  };

  // Check the effective root before expanding the whole schema. Ordinary tools,
  // including their nested unions and recursive schemas, retain the existing path.
  let root = schema;
  const rootRefs = new Set<string>();
  while (object(root) && typeof root.$ref === "string") {
    if (rootRefs.has(root.$ref)) return fail(`recursive root reference ${root.$ref}.`);
    rootRefs.add(root.$ref);
    root = { ...resolve(root.$ref), ...Object.fromEntries(Object.entries(root).filter(([key]) => key !== "$ref")) };
  }
  if (!object(root) || !COMBINATORS.some(key => Object.hasOwn(root, key))) return { schema, guidance: "" };

  const intersect = (left: any, right: any, path: string): any => {
    if (left === true) return right;
    if (right === true) return left;
    if (left === false || right === false) return fail(`unsatisfiable constraint at ${path}.`);
    if (!object(left) || !object(right)) return fail(`invalid schema at ${path}.`);
    if (isDeepStrictEqual(left, right)) return left;
    for (const [closed, other] of [[left, right], [right, left]]) {
      if (closed.additionalProperties === false
        && Object.keys(other.properties || {}).some(name => !Object.hasOwn(closed.properties || {}, name))) {
        return fail(`cannot safely intersect closed objects with different properties at ${path}.`);
      }
    }
    for (const [a, b] of [[left, right], [right, left]]) {
      if (Array.isArray(a.allOf)) {
        return a.allOf.reduce((result: any, part: any) => intersect(result, part, path),
          intersect(Object.fromEntries(Object.entries(a).filter(([key]) => key !== "allOf")), b, path));
      }
      for (const key of ["anyOf", "oneOf"]) {
        if (Array.isArray(a[key])) {
          if (path.includes(".properties.")) return fail(`cannot safely intersect a property-level ${key} at ${path} through the Claude bridge.`);
          const siblings = Object.fromEntries(Object.entries(a).filter(([name]) => name !== key));
          // Root references can combine unions with sibling constraints. The
          // root flattener below retains the resulting alternatives and rules.
          return { [key]: a[key].map((part: any) => intersect(intersect(siblings, part, path), b, path)) };
        }
      }
    }

    const result: Schema = { ...left };
    const enumValues = (value: Schema): any[] | undefined => Object.hasOwn(value, "const")
      ? (Array.isArray(value.enum) ? value.enum.filter(v => isDeepStrictEqual(v, value.const)) : [value.const])
      : (Array.isArray(value.enum) ? value.enum : undefined);
    const leftEnum = enumValues(left), rightEnum = enumValues(right);
    if (leftEnum || rightEnum) {
      const values = leftEnum && rightEnum
        ? leftEnum.filter(value => rightEnum.some(other => isDeepStrictEqual(value, other)))
        : (leftEnum || rightEnum)!;
      if (!values.length) return fail(`disjoint enum/const values at ${path}.`);
      delete result.const;
      result.enum = values;
    }
    for (const [key, value] of Object.entries(right)) {
      if (key === "const" || key === "enum") continue;
      if (!Object.hasOwn(left, key)) { result[key] = value; continue; }
      const previous = left[key];
      if (isDeepStrictEqual(previous, value)) continue;
      if (key === "properties" && object(previous) && object(value)) {
        result.properties = Object.fromEntries(unique([...Object.keys(previous), ...Object.keys(value)]).map(name => [name,
          Object.hasOwn(previous, name) && Object.hasOwn(value, name)
            ? intersect(previous[name], value[name], `${path}.properties.${name}`)
            : Object.hasOwn(previous, name) ? previous[name] : value[name],
        ]));
      } else if (key === "required" && Array.isArray(previous) && Array.isArray(value)) {
        result.required = unique([...previous, ...value]);
      } else if (key === "type") {
        const a = (Array.isArray(previous) ? previous : [previous]).map(t => String(t).toLowerCase());
        const b = (Array.isArray(value) ? value : [value]).map(t => String(t).toLowerCase());
        const types = unique([...a.filter(t => b.includes(t)),
          ...(a.includes("integer") && b.includes("number") || b.includes("integer") && a.includes("number") ? ["integer"] : [])]);
        if (!types.length) return fail(`incompatible types at ${path}.`);
        result.type = types.length === 1 ? types[0] : types;
      } else if (["minimum", "minLength", "minItems", "minProperties"].includes(key) && typeof previous === "number" && typeof value === "number") {
        result[key] = Math.max(previous, value);
      } else if (["maximum", "maxLength", "maxItems", "maxProperties"].includes(key) && typeof previous === "number" && typeof value === "number") {
        result[key] = Math.min(previous, value);
      } else if (key === "items" && object(previous) && object(value)) {
        result.items = intersect(previous, value, `${path}.items`);
      } else if (key === "additionalProperties") {
        result[key] = previous === false || value === false ? false
          : previous === true ? value : value === true ? previous : intersect(previous, value, `${path}.${key}`);
      } else if (key === "description") {
        result.description = [previous, value].filter(Boolean).join("\n");
      } else if (["title", "default", "examples", "example", "$schema", "$id", "$comment"].includes(key)) {
        delete result[key];
      } else {
        return fail(`cannot safely intersect ${key} at ${path}.`);
      }
    }
    for (const [min, max] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"], ["minProperties", "maxProperties"]]) {
      if (typeof result[min] === "number" && typeof result[max] === "number" && result[min] > result[max]) return fail(`incompatible ${min}/${max} at ${path}.`);
    }
    return result;
  };

  const mapSubschemas = (value: Schema, visit: (part: any) => any): Schema => Object.fromEntries(
    Object.entries(value).map(([key, part]) => [key,
      key === "properties" && object(part)
        ? Object.fromEntries(Object.entries(part).map(([name, property]) => [name, visit(property)]))
        : COMBINATORS.includes(key as typeof COMBINATORS[number]) && Array.isArray(part)
          ? part.map(visit)
          : ["items", "additionalProperties"].includes(key) && object(part) ? visit(part) : part,
    ]),
  );
  const expand = (value: any, refs: Set<string> = new Set()): any => {
    if (!object(value)) return value;
    const fields = Object.fromEntries(Object.entries(value).filter(([key]) => !["$ref", "$defs", "definitions"].includes(key)));
    if (typeof value.$ref === "string") {
      if (refs.has(value.$ref)) return fail(`recursive reference ${value.$ref} in a root-composed schema.`);
      const nextRefs = new Set(refs).add(value.$ref);
      return intersect(expand(resolve(value.$ref), nextRefs), expand(fields, refs), value.$ref);
    }
    return mapSubschemas(fields, part => expand(part, refs));
  };

  // Remove prose from the guidance to avoid repeating long tool descriptions.
  // Keep the actual branch constraints, including discriminators and required.
  const constraints = (value: any): any => Array.isArray(value) ? value.map(constraints)
    : object(value) ? mapSubschemas(Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["description", "title", "default", "examples", "example", "$schema", "$id", "$comment"].includes(key))
    ), constraints) : value;
  const unionProperty = (options: any[], path: string): any => {
    const alternatives = unique(options);
    if (alternatives.length === 1) return alternatives[0];
    const values = (option: Schema): any[] | undefined => Object.hasOwn(option, "const")
      ? [option.const] : Array.isArray(option.enum) ? option.enum : undefined;
    const typeOfValue = (value: any): string => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const types = unique(alternatives.flatMap(option => {
      if (!object(option)) return fail(`cannot represent a boolean property schema at ${path}.`);
      const declared = option.type ?? (option.properties ? "object" : option.items ? "array" : undefined);
      const inferred = declared == null ? values(option)?.map(typeOfValue) : (Array.isArray(declared) ? declared : [declared]);
      if (!inferred?.length) return fail(`cannot infer a common property type at ${path}.`);
      return inferred.map((type: string) => type.toLowerCase());
    }));
    if (types.includes("number") && types.includes("integer")) types.splice(types.indexOf("integer"), 1);
    // Google's Claude converter rejects generated property anyOf schemas too.
    // Use a typed envelope and retain branch constraints in tool guidance.
    // A mixed-type union has no safe envelope on this protocol path.
    if (types.length !== 1) return fail(`cannot represent mixed property types at ${path} through the Claude bridge.`);
    const result: Schema = { type: types[0] };
    const enums = alternatives.map(values);
    if (enums.every(value => value != null)) result.enum = unique(enums.flat());
    for (const key of ["description", "title", "format", "pattern", "default"]) {
      if (alternatives[0][key] !== undefined && alternatives.every(option => isDeepStrictEqual(option[key], alternatives[0][key]))) result[key] = alternatives[0][key];
    }
    for (const key of ["minimum", "minLength", "minItems", "minProperties"]) {
      if (alternatives.every(option => typeof option[key] === "number")) result[key] = Math.min(...alternatives.map(option => option[key]));
    }
    for (const key of ["maximum", "maxLength", "maxItems", "maxProperties"]) {
      if (alternatives.every(option => typeof option[key] === "number")) result[key] = Math.max(...alternatives.map(option => option[key]));
    }
    if (result.type === "object") {
      const names = unique(alternatives.flatMap(option => Object.keys(option.properties || {})));
      result.properties = Object.fromEntries(names.map(name => [name,
        unionProperty(alternatives.filter(option => Object.hasOwn(option.properties || {}, name)).map(option => option.properties[name]), `${path}.properties.${name}`),
      ]));
      const required = (alternatives[0].required || []).filter((name: string) => alternatives.every(option => option.required?.includes(name)));
      if (required.length) result.required = required;
    } else if (result.type === "array") {
      if (!alternatives.every(option => object(option.items))) return fail(`cannot represent unconstrained array items at ${path}.`);
      result.items = unionProperty(alternatives.map(option => option.items), `${path}.items`);
    }
    return result;
  };
  const guidance: string[] = [];
  const flatten = (node: any, path: string): Schema => {
    if (node === true) return { type: "object" };
    if (!object(node)) return fail(`an object parameter schema is required at ${path}.`);
    if (node.type != null && String(node.type).toLowerCase() !== "object") return fail(`non-object branch at ${path}.`);
    const base = Object.fromEntries(Object.entries(node).filter(([key]) => !COMBINATORS.includes(key as typeof COMBINATORS[number])));
    for (const key of Object.keys(base)) if (!ROOT_FIELDS.has(key)) return fail(`unsupported object constraint ${key} at ${path}.`);
    let result: Schema = { ...base, type: "object" };
    for (const key of COMBINATORS) {
      if (!Object.hasOwn(node, key)) continue;
      if (!Array.isArray(node[key]) || !node[key].length) return fail(`${key} must contain branches at ${path}.`);
      const branches = node[key].map((branch: any, index: number) => flatten(branch, `${path}.${key}[${index}]`));
      if (key === "allOf") {
        for (const branch of branches) result = intersect(result, branch, path);
      } else {
        const propertyOptions: Record<string, any[]> = Object.create(null);
        for (const branch of branches) {
          for (const [name, property] of Object.entries(branch.properties || {})) {
            (propertyOptions[name] ??= []).push(property);
          }
        }
        const properties = Object.fromEntries(Object.entries(propertyOptions).map(([name, options]) => [name, unionProperty(options, `${path}.properties.${name}`)]));
        const required = (branches[0].required || []).filter((name: string) => branches.every((branch: Schema) => branch.required?.includes(name)));
        result = intersect(result, { type: "object", properties, ...(required.length ? { required } : {}) }, path);
      }
      if (path === "parameters") {
        const rule = key === "allOf" ? "Satisfy every parameter group" : key === "oneOf" ? "Satisfy exactly one parameter group" : "Satisfy at least one parameter group";
        guidance.push(`${rule} (${key}): ${JSON.stringify(constraints(node[key]))}.`);
      }
    }
    return result;
  };
  return { schema: flatten(expand(schema), "parameters"), guidance: guidance.join("\n") };
}
