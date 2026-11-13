import { createHash } from "node:crypto";

/** Hub 2.31.2 uses a signed decimal session ID and slash-delimited agent IDs. */
export function createAntigravityRequestContext(sessionKey: string | undefined, model: string, modelEnum?: string) {
  const key = sessionKey || crypto.randomUUID();
  let sessionHash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(key)) {
    sessionHash = BigInt.asUintN(64, (sessionHash ^ BigInt(byte)) * 1099511628211n);
  }
  const digest = createHash("sha256").update(key).digest("hex");
  const cascadeId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const trajectoryId = crypto.randomUUID();
  const isClaude = model.includes("claude");
  return {
    sessionId: BigInt.asIntN(64, sessionHash).toString(),
    requestId: `agent/${cascadeId}/${Date.now()}/${trajectoryId}/1`,
    labels: {
      cascade_id: cascadeId,
      root_cascade_id: cascadeId,
      trajectory_id: trajectoryId,
      request_id: `${trajectoryId}-0`,
      last_step_index: "0",
      ...(modelEnum ? { model_enum: modelEnum } : {}),
      used_claude: String(isClaude),
      used_claude_conservative: String(isClaude),
      used_non_gemini_model: String(!model.includes("gemini")),
    },
  };
}

/** Unknown protobuf enum values are numeric; Hydrogen XHigh is value 100. */
export function antigravityThinkingLevel(level: string | number): string | number {
  if (typeof level === "number") return ({ 1: "LOW", 2: "MEDIUM", 3: "HIGH" } as Record<number, string>)[level] || level;
  return level.toLowerCase() === "xhigh" ? 100 : level.toUpperCase();
}
