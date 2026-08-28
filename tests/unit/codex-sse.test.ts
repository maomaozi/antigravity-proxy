import { describe, expect, test } from "bun:test";
import { aggregateCodexResponsesSSE, passthroughCodexSSE } from "../../src/codex/sse";

describe("Codex Responses SSE", () => {
  test("aggregates terminal canonical Responses JSON and retains completed output items", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_1"}}\n\n'));
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n'));
        controller.close();
      },
    });
    const result = await aggregateCodexResponsesSSE(new Response(stream));
    expect(result.id).toBe("resp_1");
    expect(result.output).toEqual([{ type: "message", id: "msg_1" }]);
  });

  test("passes streamed bytes through exactly while observing terminal usage", async () => {
    const raw = 'event: response.completed\r\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":6,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":10}}}\r\n\r\n';
    let observed: any = null;
    const transformed = passthroughCodexSSE(
      new Response(raw).body!,
      usage => { observed = usage; },
    );
    expect(await new Response(transformed).text()).toBe(raw);
    expect(observed).toMatchObject({ outputTokens: 4, reasoningTokens: 2, totalTokens: 10 });
  });

  test("observes terminal usage before EOF when the downstream cancels after response.completed", async () => {
    const raw = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":5,"output_tokens_details":{"reasoning_tokens":1},"total_tokens":13}}}\n\n';
    const encoder = new TextEncoder();
    let observed: any = null;
    let observedCount = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        // Deliberately keep the upstream open. Real Codex CLI can stop reading as
        // soon as it receives response.completed instead of waiting for EOF.
      },
    });
    const reader = passthroughCodexSSE(source, usage => {
      observed = usage;
      observedCount++;
    }).getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(raw);
    expect(observed).toMatchObject({ inputTokens: 8, outputTokens: 4, reasoningTokens: 1, totalTokens: 13 });
    expect(observedCount).toBe(1);

    await reader.cancel();
    expect(observedCount).toBe(1);
  });
});
