import { describe, expect, test } from "bun:test";
import { CodexSSEUsageCollector, normalizeCodexUsage } from "../../src/codex/usage";

describe("Codex usage adapter", () => {
  test("converts inclusive Responses output tokens into existing visible+reasoning semantics", () => {
    expect(normalizeCodexUsage({
      input_tokens: 31,
      input_tokens_details: { cached_tokens: 7 },
      output_tokens: 21,
      output_tokens_details: { reasoning_tokens: 13 },
      total_tokens: 52,
    })).toEqual({
      inputTokens: 31,
      cachedInputTokens: 7,
      outputTokens: 8,
      reasoningTokens: 13,
      reasoningTokensReported: true,
      totalTokens: 52,
    });
  });

  test("clamps inconsistent reasoning subsets and preserves missing cache metadata", () => {
    expect(normalizeCodexUsage({
      input_tokens: 4,
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 9 },
      total_tokens: 7,
    })).toEqual({
      inputTokens: 4,
      cachedInputTokens: null,
      outputTokens: 0,
      reasoningTokens: 9,
      reasoningTokensReported: true,
      totalTokens: 7,
    });
  });

  test("collects terminal Responses usage across split SSE chunks without mutating bytes", () => {
    const collector = new CodexSSEUsageCollector();
    const encoder = new TextEncoder();
    const chunks = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":31,"input_tokens_details":{"cached_tokens":7},',
      '"output_tokens":21,"output_tokens_details":{"reasoning_tokens":13},"total_tokens":52}}}\n\n',
    ].map(part => encoder.encode(part));

    for (const chunk of chunks) collector.push(chunk);
    expect(collector.finish()).toEqual({
      inputTokens: 31,
      cachedInputTokens: 7,
      outputTokens: 8,
      reasoningTokens: 13,
      reasoningTokensReported: true,
      totalTokens: 52,
    });
  });

  test("does not manufacture usage from response.failed", () => {
    const collector = new CodexSSEUsageCollector();
    collector.push(new TextEncoder().encode(
      'event: response.failed\ndata: {"type":"response.failed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n',
    ));
    expect(collector.finish()).toBeNull();
  });
});
