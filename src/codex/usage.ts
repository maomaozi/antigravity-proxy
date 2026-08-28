export interface CodexNormalizedUsage {
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningTokens: number;
  reasoningTokensReported: boolean;
  totalTokens: number;
}

function tokenCount(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

export function normalizeCodexUsage(usage: any): CodexNormalizedUsage {
  const inputTokens = tokenCount(usage?.input_tokens);
  const cachedRaw = usage?.input_tokens_details?.cached_tokens;
  const cachedInputTokens = cachedRaw === undefined || cachedRaw === null
    ? null
    : tokenCount(cachedRaw);
  const inclusiveOutput = tokenCount(usage?.output_tokens);
  const reasoningRaw = usage?.output_tokens_details?.reasoning_tokens;
  const reasoningTokensReported = reasoningRaw !== undefined && reasoningRaw !== null;
  const reasoningTokens = reasoningTokensReported ? tokenCount(reasoningRaw) : 0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens: Math.max(0, inclusiveOutput - reasoningTokens),
    reasoningTokens,
    reasoningTokensReported,
    totalTokens: tokenCount(usage?.total_tokens),
  };
}

interface ParsedSSEEvent {
  event?: string;
  data: string;
}

function parseBlock(block: string): ParsedSSEEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

export class CodexSSEUsageCollector {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private usage: CodexNormalizedUsage | null = null;

  push(value: Uint8Array): void {
    this.buffer += this.decoder.decode(value, { stream: true });
    this.consume(false);
  }

  finish(): CodexNormalizedUsage | null {
    this.buffer += this.decoder.decode();
    this.consume(true);
    return this.usage;
  }

  private consume(flush: boolean): void {
    while (true) {
      const separator = /\r?\n\r?\n/.exec(this.buffer);
      if (!separator) break;
      const block = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      this.consumeBlock(block);
    }
    if (flush && this.buffer.trim()) {
      this.consumeBlock(this.buffer);
      this.buffer = "";
    }
  }

  private consumeBlock(block: string): void {
    const parsed = parseBlock(block);
    if (!parsed) return;
    const raw = parsed.data.trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const payload = JSON.parse(raw);
      const type = payload?.type || parsed.event;
      if (type !== "response.completed" && type !== "response.incomplete") return;
      const usage = payload?.response?.usage;
      if (usage && typeof usage === "object") this.usage = normalizeCodexUsage(usage);
    } catch {
      // Passthrough observation is deliberately non-fatal.
    }
  }
}
