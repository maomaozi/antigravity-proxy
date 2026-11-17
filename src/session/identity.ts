import { createHash, randomUUID } from "node:crypto";
import type { CompletionRequest } from "../core/completion";
import { normalizeModelId } from "../models";

export interface SessionIdentity {
  /** Stable, opaque key used for persistence and account affinity. */
  key: string;
  /** Client-provided ID, or an opaque history/generated fallback. */
  id: string;
  source: string;
  inferred: boolean;
  /** Caller isolation scope used when falling back to payload digest matching. */
  callerScope?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 512) : undefined;
}

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

export function extractCallerScope(headers?: Headers): string | undefined {
  if (!headers) return undefined;
  const parts: string[] = [];
  for (const name of [
    "authorization",
    "x-api-key",
    "x-forwarded-for",
    "cf-connecting-ip",
    "x-real-ip",
    "user-agent",
    "origin",
  ]) {
    const value = asNonEmptyString(headers.get(name));
    if (value) parts.push(`${name}:${value}`);
  }
  return parts.length > 0 ? sha256(parts.join("|")) : undefined;
}

/**
 * Computes a stable SHA-256 digest of the model-visible completion payload.
 * Excludes requestId, timestamps, account, and credentials; includes model,
 * thinking tier/budget, system instructions, messages, tools, and caller scope.
 */
export function computeRequestPayloadDigest(
  request: CompletionRequest,
  callerScope?: string,
): string {
  const normalizedMessages = (request.messages || []).map(message => ({
    role: String(message?.role || "").toLowerCase(),
    content: message?.content ?? null,
    reasoningContent: message?.reasoningContent ?? null,
    toolCallId: message?.toolCallId ?? null,
    name: message?.name ?? null,
    toolCalls: Array.isArray(message?.toolCalls)
      ? message.toolCalls.map(tc => ({
          id: tc?.id ?? "",
          name: tc?.name ?? "",
          arguments: typeof tc?.arguments === "string"
            ? (() => {
                try {
                  return JSON.parse(tc.arguments || "{}");
                } catch {
                  return tc.arguments;
                }
              })()
            : (tc?.arguments ?? {}),
          thoughtSignature: tc?.thoughtSignature ?? null,
        }))
      : null,
  }));

  const normalizedTools = Array.isArray(request.tools)
    ? request.tools.map(tool => ({
        name: tool?.name ?? "",
        description: tool?.description ?? null,
        parameters: tool?.parameters ?? null,
        strict: typeof tool?.strict === "boolean" ? tool.strict : null,
      }))
    : null;

  const payload = {
    callerScope: callerScope || "default",
    model: normalizeModelId(String(request.model || "")),
    reasoningEffort: request.reasoningEffort ? request.reasoningEffort.trim().toLowerCase() : null,
    thinkingBudget: typeof request.thinkingBudget === "number" ? request.thinkingBudget : null,
    responseFormat: request.responseFormat ?? null,
    webSearch: request.webSearch === true,
    stopSequences: request.stopSequences ?? null,
    messages: normalizedMessages,
    tools: normalizedTools,
  };

  return sha256(stableSerialize(payload));
}

export function resolveRoutingGuardKeys(
  identity: SessionIdentity,
  request: CompletionRequest,
): {
  sessionScopeKey: string;
  digestScopeKey: string | undefined;
  payloadDigest: string;
} {
  const payloadDigest = computeRequestPayloadDigest(request, identity.callerScope);
  const digestScopeKey = `digest:${payloadDigest}`;
  if (!identity.inferred) {
    return {
      sessionScopeKey: identity.key,
      digestScopeKey: undefined,
      payloadDigest,
    };
  }
  if (identity.source === "generated") {
    return {
      sessionScopeKey: digestScopeKey,
      digestScopeKey: undefined,
      payloadDigest,
    };
  }
  return {
    sessionScopeKey: identity.callerScope ? `${identity.key}:${identity.callerScope}` : identity.key,
    digestScopeKey: undefined,
    payloadDigest,
  };
}

function parseCodexMetadata(headers: Headers): string | undefined {
  const value = headers.get("x-codex-turn-metadata");
  if (!value || value.length > 65536) return undefined;
  try {
    const metadata = JSON.parse(value) as Record<string, unknown>;
    return asNonEmptyString(metadata.session_id ?? metadata.sessionId);
  } catch {
    return undefined;
  }
}

function configuredCookieSession(headers: Headers): string | undefined {
  const names = (process.env.SESSION_COOKIE_NAMES || "")
    .split(",")
    .map(name => name.trim())
    .filter(Boolean);
  if (names.length === 0) return undefined;

  const cookies = headers.get("cookie");
  if (!cookies) return undefined;
  const parsed = new Map<string, string>();
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) parsed.set(name, value);
  }
  for (const name of names) {
    const value = asNonEmptyString(parsed.get(name));
    if (value) return value;
  }
  return undefined;
}

function historyAnchor(body: any, messagesOverride?: unknown[]): string | undefined {
  const messages = messagesOverride ?? body?.messages;
  if (!Array.isArray(messages)) return undefined;
  const prefix: unknown[] = [];
  let foundUser = false;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").toLowerCase();
    if (role === "system" || role === "developer") {
      prefix.push({ role, content: message.content });
      continue;
    }
    if (role === "user") {
      prefix.push({ role, content: message.content });
      foundUser = true;
      break;
    }
  }

  if (!foundUser) return undefined;
  return `history:${sha256(stableSerialize(prefix))}`;
}

function makeIdentity(id: string, source: string, inferred: boolean, callerScope?: string): SessionIdentity {
  // The source is deliberately excluded: clients may expose the same stable ID
  // through different compatibility fields across upgrades.
  return {
    key: sha256(id),
    id,
    source,
    inferred,
    ...(callerScope ? { callerScope } : {}),
  };
}

export function resolveSessionIdentity(headers: Headers, body: any, historyMessages?: unknown[]): SessionIdentity {
  const callerScope = extractCallerScope(headers);
  const candidates: Array<[string, unknown]> = [
    ["x-session-affinity", headers.get("x-session-affinity")],
    ["prompt_cache_key", body?.prompt_cache_key],
    ["x-opencode-session", headers.get("x-opencode-session")],
    ["session-id", headers.get("session-id")],
    ["x-session-id", headers.get("x-session-id")],
    ["session_id", headers.get("session_id")],
    ["x-codex-turn-metadata", parseCodexMetadata(headers)],
    ["metadata.session_id", body?.metadata?.session_id ?? body?.metadata?.sessionId],
    ["conversation_id", body?.conversation_id],
    ["conversation", typeof body?.conversation === "string" ? body.conversation : body?.conversation?.id],
    ["thread-id", headers.get("thread-id")],
    ["configured-cookie", configuredCookieSession(headers)],
  ];

  for (const [source, rawValue] of candidates) {
    const id = asNonEmptyString(rawValue);
    if (id) return makeIdentity(id, source, false, callerScope);
  }

  const anchor = historyAnchor(body, historyMessages);
  if (anchor) return makeIdentity(anchor, "history-anchor", true, callerScope);

  return makeIdentity(`generated:${randomUUID()}`, "generated", true, callerScope);
}

export function resolveCodexAffinityIdentity(headers: Headers, body: any, historyMessages?: unknown[]): SessionIdentity {
  const callerScope = extractCallerScope(headers);
  const explicitAffinity = asNonEmptyString(headers.get("x-session-affinity"));
  if (explicitAffinity) return makeIdentity(explicitAffinity, "x-session-affinity", false, callerScope);

  const threadId = asNonEmptyString(headers.get("thread-id"));
  if (threadId) return makeIdentity(`codex-thread:${threadId}`, "thread-id", false, callerScope);

  return resolveSessionIdentity(headers, body, historyMessages);
}
