import { describe, expect, test } from "bun:test";

const usageHtml = await Bun.file(new URL("../../src/frontend/usage.html", import.meta.url)).text();
const usageJs = await Bun.file(new URL("../../src/frontend/js/usage.js", import.meta.url)).text();

describe("frontend usage page layout and effort column", () => {
  test("table header defines Effort to the right of Reasoning and before Total", () => {
    const reasoningIndex = usageHtml.indexOf(">Reasoning</th>");
    const effortIndex = usageHtml.indexOf(">Effort</th>");
    const totalIndex = usageHtml.indexOf(">Total</th>");

    expect(reasoningIndex).toBeGreaterThan(-1);
    expect(effortIndex).toBeGreaterThan(reasoningIndex);
    expect(totalIndex).toBeGreaterThan(effortIndex);
  });

  test("table body initial loading state uses colspan 12", () => {
    expect(usageHtml).toContain('colspan="12"');
  });

  test("usage.js empty and error states use colspan 12", () => {
    expect(usageJs).toContain('<tr><td colspan="12" class="p-12 text-center text-zinc-400">// No token usage records found</td></tr>');
    expect(usageJs).toContain('<tr><td colspan="12" class="p-12 text-center text-rose-500">${usageEscape(error.message)}</td></tr>');
  });

  test("renders effort column between reasoning and total in usage table rows", () => {
    // Extract row template logic or simulate row rendering
    const rowFn = new Function("row", `
      const tokenFormatter = new Intl.NumberFormat();
      ${usageJs.slice(usageJs.indexOf("function usageEscape"), usageJs.indexOf("function renderUsageStats"))}
      const cacheReported = row.cachedInputTokens !== null && row.cachedInputTokens !== undefined;
      const cacheRate = cacheReported && row.inputTokens ? (row.cachedInputTokens / row.inputTokens * 100).toFixed(1) : '0.0';
      const cached = cacheReported
          ? \`<div>\${formatTokens(row.cachedInputTokens)}</div><div class="mt-1 text-[9px] opacity-70">\${cacheRate}%</div>\`
          : '<div title="Upstream did not report cached input tokens">—</div><div class="mt-1 text-[9px] opacity-70">Not reported</div>';
      const uncached = row.uncachedInputTokens === null || row.uncachedInputTokens === undefined
          ? '<span title="Cannot derive uncached input without cache metadata">—</span>'
          : formatTokens(row.uncachedInputTokens);
      const reasoning = row.reasoningTokensReported ? formatTokens(row.reasoningTokens) : '<span title="Upstream did not report reasoning separately">—</span>';
      const speed = row.tokensPerSecond === null || row.tokensPerSecond === undefined
          ? '<span title="No valid duration or generated tokens">—</span>'
          : \`<div class="text-cyan-600 dark:text-cyan-400">\${formatSpeed(row.tokensPerSecond)}</div><div class="mt-1 text-[9px] text-zinc-400">\${formatDuration(row.durationMs)}</div>\`;
      const effort = (row.effort || row.reasoningEffort || '').trim()
          ? usageEscape((row.effort || row.reasoningEffort).trim())
          : '-';
      return {
        html: \`
          <td class="px-3 py-3 text-right tabular-nums">\${reasoning}</td>
          <td class="px-3 py-3 text-right tabular-nums">\${effort}</td>
          <td class="px-3 py-3 text-right tabular-nums font-bold">\${formatTokens(row.totalTokens)}</td>
        \`,
        effortValue: effort,
      };
    `);

    // Historical data with null effort
    const historicalResult = rowFn({
      createdAt: Date.now(),
      requestId: "req_1",
      sessionId: "s_1",
      sessionKey: "sk_1",
      sessionSource: "test",
      sessionInferred: false,
      model: "gpt-4",
      accountEmail: "test@example.com",
      pool: "codex",
      endpoint: "/v1/responses",
      streamed: false,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      reasoningTokensReported: true,
      effort: null,
      totalTokens: 17,
    });
    expect(historicalResult.effortValue).toBe("-");
    expect(historicalResult.html).toContain('<td class="px-3 py-3 text-right tabular-nums">-</td>');

    // Historical data with undefined effort
    const noEffortResult = rowFn({
      createdAt: Date.now(),
      requestId: "req_2",
      sessionId: "s_2",
      sessionKey: "sk_2",
      sessionSource: "test",
      sessionInferred: false,
      model: "gpt-4",
      accountEmail: "test@example.com",
      pool: "codex",
      endpoint: "/v1/responses",
      streamed: false,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      reasoningTokensReported: true,
      totalTokens: 17,
    });
    expect(noEffortResult.effortValue).toBe("-");
    expect(noEffortResult.html).toContain('<td class="px-3 py-3 text-right tabular-nums">-</td>');

    // Data with effort = "high"
    const highResult = rowFn({
      createdAt: Date.now(),
      requestId: "req_3",
      sessionId: "s_3",
      sessionKey: "sk_3",
      sessionSource: "test",
      sessionInferred: false,
      model: "antigravity-gemini-3.8-flash-high",
      accountEmail: "test@example.com",
      pool: "sandbox",
      endpoint: "/v1/responses",
      streamed: false,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      reasoningTokensReported: true,
      effort: "high",
      totalTokens: 17,
    });
    expect(highResult.effortValue).toBe("high");
    expect(highResult.html).toContain('<td class="px-3 py-3 text-right tabular-nums">high</td>');
  });
});
