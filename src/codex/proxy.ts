import { randomUUID } from "node:crypto";
import { callCodexCompactAPI, callCodexResponsesAPI } from "./api";
import { aggregateCodexResponsesSSE, passthroughCodexSSE } from "./sse";
import { normalizeCodexUsage, type CodexNormalizedUsage } from "./usage";
import type { CodexAccountManager, CodexAccount } from "./account-manager";
import type { SessionIdentity } from "../session/identity";
import type { SessionBindingStore } from "../session/store";

function isCodexModelCapacityError(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("selected model is at capacity") || lower.includes("model is at capacity. please try a different model");
}

function retryAfterMs(response: Response, rawBody: string): number {
  const standard = response.headers.get("retry-after")?.trim();
  if (standard) {
    const seconds = Number(standard);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
    const date = Date.parse(standard);
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  try {
    const error = JSON.parse(rawBody)?.error;
    if (error?.resets_at) {
      const epoch = Number(error.resets_at) * 1000;
      if (Number.isFinite(epoch) && epoch > Date.now()) return epoch - Date.now();
    }
    if (error?.resets_in_seconds) {
      const duration = Number(error.resets_in_seconds) * 1000;
      if (Number.isFinite(duration) && duration > 0) return duration;
    }
  } catch {}
  return 60_000;
}

interface ProxyRequest {
  body: any;
  model: string;
  identity: SessionIdentity;
  requestId: string;
  requestStartedAt: number;
}

export class CodexProxyService {
  private readonly manager: CodexAccountManager;
  private readonly store: SessionBindingStore;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly responsesTimeoutMs: number;
  private readonly compactTimeoutMs: number;
  private readonly baseUrl?: string;

  constructor(options: {
    manager: CodexAccountManager;
    store: SessionBindingStore;
    fetchImpl?: typeof fetch;
    maxAttempts?: number;
    responsesTimeoutMs?: number;
    compactTimeoutMs?: number;
    baseUrl?: string;
  }) {
    this.manager = options.manager;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl || fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.responsesTimeoutMs = options.responsesTimeoutMs ?? 120_000;
    this.compactTimeoutMs = options.compactTimeoutMs ?? 60_000;
    this.baseUrl = options.baseUrl;
  }

  responses(request: ProxyRequest): Promise<Response> {
    return this.proxy("responses", request);
  }

  compact(request: ProxyRequest): Promise<Response> {
    return this.proxy("compact", request);
  }

  private async proxy(operation: "responses" | "compact", request: ProxyRequest): Promise<Response> {
    const endpoint = operation === "responses" ? "/v1/responses" : "/v1/responses/compact";
    const existing = this.store.get(request.identity.key, request.model);
    const preferredEmail = existing?.pool === "codex" ? existing.accountEmail : null;
    const upstreamSessionId = existing?.pool === "codex" && existing.upstreamSessionId
      ? existing.upstreamSessionId
      : randomUUID();
    const excluded = new Set<string>();
    const refreshed = new Set<string>();
    let lastResponse: Response | null = null;
    let lastStatus = 502;
    let lastBody = "";
    let lastRetryAfterMs: number | undefined;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const account = await this.manager.selectAccount({ preferredEmail, excludeEmails: excluded });
      if (!account) {
        if (lastResponse) return this.errorResponse(lastStatus, lastBody, lastRetryAfterMs);
        return Response.json({ error: { message: "No available codex account", type: "upstream_error" } }, { status: 503 });
      }

      let upstream: Response;
      try {
        const options = {
          accessToken: account.accessToken,
          accountId: account.accountId,
          sessionId: upstreamSessionId,
          body: { ...request.body, model: request.model },
          timeoutMs: operation === "responses" ? this.responsesTimeoutMs : this.compactTimeoutMs,
          fetchImpl: this.fetchImpl,
          baseUrl: this.baseUrl,
        };
        upstream = operation === "responses"
          ? await callCodexResponsesAPI(options)
          : await callCodexCompactAPI(options);
      } catch (error: any) {
        excluded.add(account.email);
        lastStatus = 502;
        lastBody = JSON.stringify({ error: { message: error?.message || "Upstream network error" } });
        continue;
      }

      if (upstream.ok) {
        this.store.record({
          identity: request.identity,
          accountEmail: account.email,
          model: request.model,
          modelFamily: "Codex",
          pool: "codex",
          endpoint,
          upstreamSessionId,
        });
        if (operation === "compact") return this.handleCompactSuccess(upstream, account, request, endpoint);
        return this.handleResponsesSuccess(upstream, account, request, endpoint);
      }

      lastResponse = upstream;
      lastBody = await upstream.text().catch(() => "");
      let status = upstream.status;
      if (isCodexModelCapacityError(lastBody)) status = 429;
      lastStatus = status;
      if (status === 401 && !refreshed.has(account.email)) {
        refreshed.add(account.email);
        if (await this.manager.refreshAccount(account.email)) continue;
      }
      excluded.add(account.email);
      if (status === 429) {
        lastRetryAfterMs = retryAfterMs(upstream, lastBody);
        await this.manager.markCooldown(account.email, lastRetryAfterMs);
      }
      if (![401, 429, 500, 502, 503, 504].includes(status)) return this.errorResponse(status, lastBody);
    }

    return this.errorResponse(lastStatus, lastBody || JSON.stringify({ error: { message: "Codex upstream request failed" } }), lastRetryAfterMs);
  }

  private async handleCompactSuccess(upstream: Response, account: CodexAccount, request: ProxyRequest, endpoint: string): Promise<Response> {
    let data: any;
    try { data = await upstream.json(); } catch {
      return Response.json({ error: { message: "Codex Compact upstream returned invalid JSON", type: "upstream_error" } }, { status: 502 });
    }
    if (data?.usage) this.recordUsage(account, request, endpoint, false, normalizeCodexUsage(data.usage));
    return new Response(JSON.stringify(data), { status: upstream.status, headers: this.jsonHeaders(upstream.headers) });
  }

  private async handleResponsesSuccess(upstream: Response, account: CodexAccount, request: ProxyRequest, endpoint: string): Promise<Response> {
    if (request.body?.stream === true) {
      if (!upstream.body) return Response.json({ error: { message: "Codex upstream response body is empty" } }, { status: 502 });
      const stream = passthroughCodexSSE(upstream.body, usage => this.recordUsage(account, request, endpoint, true, usage));
      const headers = new Headers(upstream.headers);
      headers.delete("content-length");
      headers.set("Content-Type", "text/event-stream");
      headers.set("Cache-Control", "no-cache");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(stream, { status: upstream.status, headers });
    }

    let data: any;
    try { data = await aggregateCodexResponsesSSE(upstream); } catch (error: any) {
      return Response.json({ error: { message: error?.message || "Incomplete Codex upstream stream", type: "upstream_error" } }, { status: 502 });
    }
    if (data?.usage) this.recordUsage(account, request, endpoint, false, normalizeCodexUsage(data.usage));
    return new Response(JSON.stringify(data), { status: 200, headers: this.jsonHeaders(upstream.headers) });
  }

  private recordUsage(account: CodexAccount, request: ProxyRequest, endpoint: string, streamed: boolean, usage: CodexNormalizedUsage): void {
    this.store.recordRequestTokenUsage({
      requestId: request.requestId,
      identity: request.identity,
      accountEmail: account.email,
      model: request.model,
      modelFamily: "Codex",
      upstreamModel: request.model,
      pool: "codex",
      endpoint,
      streamed,
      ...usage,
      createdAt: request.requestStartedAt,
    });
  }

  private jsonHeaders(upstream: Headers): Headers {
    const headers = new Headers(upstream);
    headers.delete("content-length");
    headers.set("Content-Type", "application/json");
    headers.set("Access-Control-Allow-Origin", "*");
    return headers;
  }

  private errorResponse(status: number, rawBody: string, retryMs?: number): Response {
    const headers = new Headers({ "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    if (status === 429 && retryMs && Number.isFinite(retryMs) && retryMs > 0) {
      headers.set("Retry-After", String(Math.max(1, Math.ceil(retryMs / 1000))));
    }
    try {
      const parsed = rawBody ? JSON.parse(rawBody) : null;
      return new Response(JSON.stringify(parsed && typeof parsed === "object" ? parsed : { error: { message: "Codex upstream request failed" } }), { status, headers });
    } catch {
      return new Response(JSON.stringify({ error: { message: "Codex upstream request failed" } }), { status, headers });
    }
  }
}
