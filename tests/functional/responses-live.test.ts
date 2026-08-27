import { describe, expect, test } from "bun:test";

const BASE_URL = process.env.ANTIGRAVITY_LIVE_BASE_URL;
const MODEL = process.env.ANTIGRAVITY_LIVE_MODEL || "antigravity-gemini-3.7-flash";
const liveDescribe = BASE_URL ? describe : describe.skip;

async function post(body: any, affinity: string): Promise<{ response: Response; data: any }> {
  const response = await fetch(`${BASE_URL}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-affinity": affinity,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON response (${response.status}), received: ${text.slice(0, 1000)}`);
  }
  return { response, data };
}

liveDescribe("Live Responses API compatibility", () => {
  test("non-streaming response returns standard Responses output and usage", async () => {
    const { response, data } = await post({
      model: MODEL,
      input: "Reply with exactly: responses-live-ok",
      max_output_tokens: 256,
    }, `responses-basic-${crypto.randomUUID()}`);

    expect(response.status).toBe(200);
    expect(data.object).toBe("response");
    expect(data.status).toBe("completed");
    expect(data.id.startsWith("resp_")).toBe(true);
    expect(data.output_text).toContain("responses-live-ok");
    expect(data.output.some((item: any) => item.type === "message")).toBe(true);
    expect(typeof data.usage.input_tokens).toBe("number");
    expect(typeof data.usage.output_tokens).toBe("number");
    expect(typeof data.usage.input_tokens_details.cached_tokens).toBe("number");
    expect(data.usage.total_tokens).toBe(data.usage.input_tokens + data.usage.output_tokens);
    expect(data.usage.output_tokens).toBeGreaterThanOrEqual(data.usage.output_tokens_details.reasoning_tokens);
  }, 120_000);

  test("streaming response emits the Responses lifecycle and no Chat DONE sentinel", async () => {
    const response = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-affinity": `responses-stream-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: "Reply with exactly: responses-stream-live-ok",
        max_output_tokens: 256,
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).not.toContain("data: [DONE]");
    const events = text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    const types = events.map(event => event.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types.at(-1)).toBe("response.completed");
    const output = events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
    expect(output).toContain("responses-stream-live-ok");
    expect(events.at(-1).response.output_text).toContain("responses-stream-live-ok");
  }, 120_000);

  test("Gemini parallel function calls preserve call IDs and round-trip via full Responses output", async () => {
    const affinity = `responses-tools-${crypto.randomUUID()}`;
    const input = "You must call both lookup_weather and lookup_time for Singapore in parallel. Do not answer directly before calling both tools.";
    const tools = [
      {
        type: "function",
        name: "lookup_weather",
        description: "Look up weather for a city",
        strict: true,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      {
        type: "function",
        name: "lookup_time",
        description: "Look up local time for a city",
        strict: true,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const first = await post({ model: MODEL, input, tools, max_output_tokens: 1024 }, affinity);
    expect(first.response.status).toBe(200);
    const calls = first.data.output.filter((item: any) => item.type === "function_call");
    expect(calls).toHaveLength(2);
    expect(calls[0].call_id.startsWith("sig:")).toBe(true);
    expect(calls[1].call_id.startsWith("sig:")).toBe(false);

    const history: any[] = [{ role: "user", content: input }, ...first.data.output];
    for (const call of calls) {
      const output = call.name === "lookup_weather"
        ? { temperature_c: 30, condition: "humid" }
        : { time: "15:55", timezone: "Asia/Singapore" };
      history.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
    }

    const second = await post({ model: MODEL, input: history, tools, max_output_tokens: 1024 }, affinity);
    expect(second.response.status).toBe(200);
    expect(second.data.status).toBe("completed");
    expect(second.data.output_text.length).toBeGreaterThan(0);
  }, 180_000);

  test("namespace function calls round-trip with namespace restored", async () => {
    const affinity = `responses-namespace-${crypto.randomUUID()}`;
    const input = "You must call test_ns.echo_value exactly once with value NS-ROUNDTRIP-731. Do not answer before calling it.";
    const tools = [{
      type: "namespace",
      name: "test_ns",
      description: "Test namespace",
      tools: [{
        type: "function",
        name: "echo_value",
        description: "Echo a value",
        strict: true,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      }],
    }];

    const first = await post({ model: MODEL, input, tools, max_output_tokens: 512 }, affinity);
    expect(first.response.status).toBe(200);
    const calls = first.data.output.filter((item: any) => item.type === "function_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].namespace).toBe("test_ns");
    expect(calls[0].name).toBe("echo_value");

    const history = [
      { role: "user", content: input },
      ...first.data.output,
      { type: "function_call_output", call_id: calls[0].call_id, output: JSON.stringify({ value: "NS-ROUNDTRIP-731" }) },
    ];
    const second = await post({ model: MODEL, input: history, tools, max_output_tokens: 512 }, affinity);
    expect(second.response.status).toBe(200);
    expect(second.data.status).toBe("completed");
    expect(second.data.output_text).toContain("NS-ROUNDTRIP-731");
  }, 180_000);

  test("custom tool calls round-trip through custom_tool_call wire items", async () => {
    const affinity = `responses-custom-${crypto.randomUUID()}`;
    const input = "You must call echo_freeform exactly once with the raw input CUSTOM-ROUNDTRIP-842. Do not answer before calling it.";
    const tools = [{
      type: "custom",
      name: "echo_freeform",
      description: "Echo raw freeform text",
      format: { type: "text", syntax: "plain", definition: "Any plain text" },
    }];

    const first = await post({ model: MODEL, input, tools, max_output_tokens: 512 }, affinity);
    expect(first.response.status).toBe(200);
    const calls = first.data.output.filter((item: any) => item.type === "custom_tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("echo_freeform");
    expect(calls[0].input).toContain("CUSTOM-ROUNDTRIP-842");

    const history = [
      { role: "user", content: input },
      ...first.data.output,
      { type: "custom_tool_call_output", call_id: calls[0].call_id, output: "CUSTOM-ROUNDTRIP-842" },
    ];
    const second = await post({ model: MODEL, input: history, tools, max_output_tokens: 512 }, affinity);
    expect(second.response.status).toBe(200);
    expect(second.data.status).toBe("completed");
    expect(second.data.output_text).toContain("CUSTOM-ROUNDTRIP-842");
  }, 180_000);

  test("json_schema structured output maps through text.format", async () => {
    const { response, data } = await post({
      model: MODEL,
      input: "Return status ok and count 3.",
      text: {
        format: {
          type: "json_schema",
          name: "live_result",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              status: { type: "string", enum: ["ok"] },
              count: { type: "integer" },
            },
            required: ["status", "count"],
          },
        },
      },
      max_output_tokens: 512,
    }, `responses-schema-${crypto.randomUUID()}`);

    expect(response.status).toBe(200);
    const parsed = JSON.parse(data.output_text);
    expect(parsed.status).toBe("ok");
    expect(parsed.count).toBe(3);
  }, 120_000);
  test("max_output_tokens terminates streaming with response.incomplete", async () => {
    const response = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-affinity": `responses-incomplete-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: "Write a long explanation of TCP congestion control.",
        max_output_tokens: 1,
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const events = text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    const terminal = events.at(-1);
    expect(terminal.type).toBe("response.incomplete");
    expect(terminal.response.status).toBe("incomplete");
    expect(terminal.response.incomplete_details).toEqual({ reason: "max_output_tokens" });
  }, 120_000);

});
