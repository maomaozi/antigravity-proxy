import { describe, expect, test } from "bun:test";
import {
  callCodexCompactAPI,
  callCodexResponsesAPI,
  normalizeCompactBody,
  normalizeResponsesBody,
} from "../../src/codex/api";

describe("Codex upstream API adapter", () => {
  test("keeps native Responses fields opaque while stripping unsupported transport knobs", () => {
    const body = {
      model: "gpt-x-codex",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      include: ["reasoning.encrypted_content"],
      unknown_future_field: { keep: true },
      previous_response_id: "resp_old",
      stream_options: { include_usage: true },
      max_output_tokens: 123,
      temperature: 0.3,
      stream: false,
    };
    expect(normalizeResponsesBody(body)).toEqual({
      model: "gpt-x-codex",
      input: body.input,
      include: body.include,
      unknown_future_field: { keep: true },
      stream: true,
    });
  });

  test("normalizes compact body like auth2api and keeps compact non-streaming", () => {
    expect(normalizeCompactBody({
      model: "gpt-x-codex",
      input: [],
      stream: true,
      max_output_tokens: 5,
      unknown_future_field: 1,
    })).toEqual({
      model: "gpt-x-codex",
      input: [],
      unknown_future_field: 1,
      instructions: "",
      parallel_tool_calls: false,
    });
  });

  test("sends Codex Responses with stable upstream session headers and prompt cache key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init || {} });
      return new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    await callCodexResponsesAPI({
      accessToken: "token",
      accountId: "account-1",
      sessionId: "upstream-session",
      body: { model: "gpt-x-codex", input: "hello" },
      timeoutMs: 1000,
      fetchImpl: fakeFetch as typeof fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("chatgpt-account-id")).toBe("account-1");
    expect(headers.get("session_id")).toBe("upstream-session");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      model: "gpt-x-codex",
      stream: true,
      prompt_cache_key: "upstream-session",
    });
  });

  test("sends compact to the native compact endpoint as JSON", async () => {
    let call: { url: string; init: RequestInit } | undefined;
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      call = { url: String(input), init: init || {} };
      return Response.json({ ok: true });
    };
    await callCodexCompactAPI({
      accessToken: "token",
      accountId: "account-1",
      sessionId: "upstream-session",
      body: { model: "gpt-x-codex", input: [] },
      timeoutMs: 1000,
      fetchImpl: fakeFetch as typeof fetch,
    });
    expect(call!.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
    expect(new Headers(call!.init.headers).get("accept")).toBe("application/json");
  });
});
