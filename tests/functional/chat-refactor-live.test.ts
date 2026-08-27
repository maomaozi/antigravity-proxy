import { describe, expect, test } from "bun:test";

const BASE_URL = process.env.ANTIGRAVITY_LIVE_BASE_URL;
const MODEL = process.env.ANTIGRAVITY_LIVE_MODEL || "antigravity-gemini-3.7-flash";
const liveDescribe = BASE_URL ? describe : describe.skip;

async function post(body: any, affinity: string): Promise<{ response: Response; data: any }> {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
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

liveDescribe("Live Chat refactor compatibility", () => {
  test("non-streaming response keeps Chat shape and usage semantics", async () => {
    const { response, data } = await post({
      model: MODEL,
      messages: [{ role: "user", content: "Reply with exactly: refactor-live-ok" }],
      stream: false,
      max_tokens: 256,
    }, `live-basic-${crypto.randomUUID()}`);

    expect(response.status).toBe(200);
    expect(data.object).toBe("chat.completion");
    expect(data.choices[0].message.content).toContain("refactor-live-ok");
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(typeof data.usage.prompt_tokens).toBe("number");
    expect(typeof data.usage.completion_tokens).toBe("number");
    expect(data.usage.prompt_tokens_details).toHaveProperty("cached_tokens");
    expect(data.usage.prompt_tokens_details.cached_tokens === null || typeof data.usage.prompt_tokens_details.cached_tokens === "number").toBe(true);
  }, 120_000);

  test("streaming response stays valid Chat SSE", async () => {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-affinity": `live-stream-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "Reply with exactly: stream-live-ok" }],
        stream: true,
        max_tokens: 256,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const events = text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)));

    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => event.object === "chat.completion.chunk")).toBe(true);
    const output = events.map(event => event.choices?.[0]?.delta?.content || "").join("");
    expect(output).toContain("stream-live-ok");
    expect(events.some(event => event.choices?.[0]?.finish_reason != null)).toBe(true);
  }, 120_000);

  test("Gemini parallel tool calls preserve per-call thought signatures and round-trip", async () => {
    const affinity = `live-tools-${crypto.randomUUID()}`;
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "lookup_time",
          description: "Look up local time for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ];

    const firstBody = {
      model: MODEL,
      messages: [{
        role: "user",
        content: "You must call both lookup_weather and lookup_time for Singapore in parallel. Do not answer directly before calling both tools.",
      }],
      tools,
      stream: false,
      max_tokens: 1024,
    };

    const first = await post(firstBody, affinity);
    expect(first.response.status).toBe(200);
    expect(first.data.choices[0].finish_reason).toBe("tool_calls");
    const calls = first.data.choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((call: any) => call.index)).toEqual([0, 1]);
    expect(calls[0].id.startsWith("sig:")).toBe(true);
    expect(typeof calls[0].extra_content?.google?.thought_signature).toBe("string");
    expect(calls[1].extra_content).toBeUndefined();

    const messages = [...firstBody.messages, first.data.choices[0].message];
    for (const call of calls) {
      const output = call.function.name === "lookup_weather"
        ? { temperature_c: 30, condition: "humid" }
        : { time: "15:42", timezone: "Asia/Singapore" };
      messages.push({
        role: "tool" as const,
        tool_call_id: call.id,
        content: JSON.stringify(output),
      } as any);
    }

    const second = await post({ ...firstBody, messages }, affinity);
    expect(second.response.status).toBe(200);
    expect(second.data.choices[0].finish_reason).toBe("stop");
    expect(second.data.choices[0].message.content.length).toBeGreaterThan(0);
  }, 180_000);

  test("json_schema structured output remains available", async () => {
    const { response, data } = await post({
      model: MODEL,
      messages: [{ role: "user", content: "Return status ok and count 3." }],
      response_format: {
        type: "json_schema",
        json_schema: {
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
      stream: false,
      max_tokens: 512,
    }, `live-schema-${crypto.randomUUID()}`);

    expect(response.status).toBe(200);
    const parsed = JSON.parse(data.choices[0].message.content);
    expect(parsed.status).toBe("ok");
    expect(parsed.count).toBe(3);
  }, 120_000);
});
