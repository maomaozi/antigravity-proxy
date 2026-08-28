import { CodexSSEUsageCollector, type CodexNormalizedUsage } from "./usage";

export class CodexSSEAggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSSEAggregationError";
  }
}

interface ParsedSSEEvent {
  event?: string;
  data: string;
}

function parseBlock(block: string): ParsedSSEEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  return dataLines.length ? { event, data: dataLines.join("\n") } : null;
}

class SSEFramer {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(value: Uint8Array): ParsedSSEEvent[] {
    this.buffer += this.decoder.decode(value, { stream: true });
    return this.consume(false);
  }

  finish(): ParsedSSEEvent[] {
    this.buffer += this.decoder.decode();
    return this.consume(true);
  }

  private consume(flush: boolean): ParsedSSEEvent[] {
    const events: ParsedSSEEvent[] = [];
    while (true) {
      const separator = /\r?\n\r?\n/.exec(this.buffer);
      if (!separator) break;
      const block = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      const event = parseBlock(block);
      if (event) events.push(event);
    }
    if (flush && this.buffer.trim()) {
      const event = parseBlock(this.buffer);
      if (event) events.push(event);
      this.buffer = "";
    }
    return events;
  }
}

function failureMessage(response: any): string {
  return response?.error?.message || response?.error?.code || response?.incomplete_details?.reason || "Codex upstream returned response.failed";
}

export async function aggregateCodexResponsesSSE(response: Response): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new CodexSSEAggregationError("Codex upstream response body is empty");
  const framer = new SSEFramer();
  const outputItems = new Map<number, any>();
  let terminalResponse: any | undefined;
  let terminalType: string | undefined;

  const consume = (events: ParsedSSEEvent[]): boolean => {
    for (const event of events) {
      const raw = event.data.trim();
      if (!raw || raw === "[DONE]") continue;
      let payload: any;
      try { payload = JSON.parse(raw); } catch { continue; }
      const type = payload?.type || event.event;
      if (type === "response.output_item.done") {
        const index = payload?.output_index;
        if (Number.isInteger(index) && index >= 0 && payload?.item !== undefined) outputItems.set(index, payload.item);
        continue;
      }
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
        if (payload?.response && typeof payload.response === "object") {
          terminalType = type;
          terminalResponse = payload.response;
          return true;
        }
      }
    }
    return false;
  };

  try {
    while (!terminalResponse) {
      const { done, value } = await reader.read();
      if (done) {
        consume(framer.finish());
        break;
      }
      if (consume(framer.push(value))) {
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (error: any) {
    throw new CodexSSEAggregationError(`Codex upstream stream terminated before completion: ${error?.message || error}`);
  }

  if (!terminalResponse || !terminalType) throw new CodexSSEAggregationError("Codex upstream stream ended without a terminal response event");
  if (terminalType === "response.failed") throw new CodexSSEAggregationError(failureMessage(terminalResponse));
  const canonical = { ...terminalResponse };
  if (!Array.isArray(canonical.output) || canonical.output.length === 0) {
    canonical.output = [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  }
  return canonical;
}

export function passthroughCodexSSE(
  source: ReadableStream<Uint8Array>,
  onUsage: (usage: CodexNormalizedUsage) => void,
): ReadableStream<Uint8Array> {
  const collector = new CodexSSEUsageCollector();
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      collector.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      const usage = collector.finish();
      if (usage) onUsage(usage);
    },
  }));
}
