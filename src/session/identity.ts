import { createHash, randomUUID } from "node:crypto";

export interface SessionIdentity {
  /** Stable, opaque key used for persistence and account affinity. */
  key: string;
  /** Client-provided ID, or an opaque history/generated fallback. */
  id: string;
  source: string;
  inferred: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 512) : undefined;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
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

function makeIdentity(id: string, source: string, inferred: boolean): SessionIdentity {
  // The source is deliberately excluded: clients may expose the same stable ID
  // through different compatibility fields across upgrades.
  return { key: sha256(id), id, source, inferred };
}

export function resolveSessionIdentity(headers: Headers, body: any, historyMessages?: unknown[]): SessionIdentity {
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
    if (id) return makeIdentity(id, source, false);
  }

  const anchor = historyAnchor(body, historyMessages);
  if (anchor) return makeIdentity(anchor, "history-anchor", true);

  return makeIdentity(`generated:${randomUUID()}`, "generated", true);
}

export function resolveCodexAffinityIdentity(headers: Headers, body: any, historyMessages?: unknown[]): SessionIdentity {
  const explicitAffinity = asNonEmptyString(headers.get("x-session-affinity"));
  if (explicitAffinity) return makeIdentity(explicitAffinity, "x-session-affinity", false);

  const threadId = asNonEmptyString(headers.get("thread-id"));
  if (threadId) return makeIdentity(`codex-thread:${threadId}`, "thread-id", false);

  return resolveSessionIdentity(headers, body, historyMessages);
}
