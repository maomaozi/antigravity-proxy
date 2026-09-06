#!/usr/bin/env bun
import { loadProxyConfig, getProxyConfig, updateProxyConfig } from "./config/manager";

await loadProxyConfig();

const pkg = await Bun.file("package.json").json();
const APP_VERSION = pkg.version || "0.0.0";

import { initManager, addAccount, getAccounts, removeAccount, saveAccounts, eventBus, markCooldown, getCooldowns, resetAccount, updateAccountProject, resetAllCooldowns } from "./auth/manager";
import { type AntigravityAccount } from "./auth/types";
import { generateAuthUrl, exchangeCode, getUserEmail, getProjectId } from "./auth/oauth";
import { validateCompletionRequestForGoogle } from "./utils/transform";
import { adaptChatCompletionRequest, createChatCompletionStreamEncoder, encodeChatCompletionResult } from "./api/openai/chat";
import { adaptResponsesRequest, createResponsesStreamEncoder, encodeResponsesResult, validateResponsesRequest } from "./api/openai/responses";
import { executeCompletion } from "./api/completion-executor";
import { OAUTH_CONFIG } from "./utils/headers";
import { refreshAllQuotas, fetchQuota } from "./api/quota";
import { createWindowActivationRuntime, startQuotaWindowActivationScheduler } from "./api/window-activation";
import { SUPPORTED_MODELS } from "./models";
import { resolveCodexAffinityIdentity, resolveSessionIdentity } from "./session/identity";
import { clearRequestTokenUsage, clearSessionBindings, deleteSessionBinding, initSessionBindingStore, listRequestTokenUsage, listSessionBindings } from "./session/store";
import { CodexAccountManager } from "./codex/account-manager";
import { CodexDeviceAuthService } from "./codex/device-auth";
import { CodexProxyService } from "./codex/proxy";
import { resolveCodexModel } from "./codex/routing";

const sessionStore = initSessionBindingStore();

function getCodexModelIds() {
  return getProxyConfig().codex?.models || [];
}

function getSupportedModelIds() {
  return [...SUPPORTED_MODELS.map(model => model.id), ...getCodexModelIds()];
}

const logBuffer: string[] = [];
const MAX_LOGS = 200;

function captureLog(level: string, args: any[]) {
    try {
        const msg = args.map(a => 
            (typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a))
        ).join(' ');
        const line = `[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] ${msg}`;
        
        logBuffer.push(line);
        if (logBuffer.length > MAX_LOGS) logBuffer.shift();
        
        eventBus.emit('log', line);
    } catch (e) {
    }
}


const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => { originalLog(...args); captureLog('info', args); };
console.error = (...args) => { originalError(...args); captureLog('error', args); };
console.warn = (...args) => { originalWarn(...args); captureLog('warn', args); };

await initManager();

const proxyConfig = getProxyConfig();

const codexAccountManager = new CodexAccountManager({
  storagePath: process.env.CODEX_ACCOUNTS_FILE || "data/codex-accounts.json",
});
await codexAccountManager.init();
const CODEX_USAGE_REFRESH_MS = 60_000;
const refreshCodexUsageState = () => codexAccountManager.getUsageSnapshots().catch(error => {
  console.warn(`[Codex] Usage refresh failed: ${error?.message || error}`);
});
const codexUsageTimer = setInterval(refreshCodexUsageState, CODEX_USAGE_REFRESH_MS);
codexUsageTimer.unref();
refreshCodexUsageState();
const codexDeviceAuthService = new CodexDeviceAuthService({
  onCredentials: async credentials => { await codexAccountManager.upsertCredentials(credentials); },
});
function createCodexProxyService() {
  const config = getProxyConfig().codex;
  return new CodexProxyService({
    manager: codexAccountManager,
    store: sessionStore,
    maxAttempts: config.maxAttempts,
    responsesTimeoutMs: config.responsesTimeoutMs,
    compactTimeoutMs: config.compactTimeoutMs,
    baseUrl: config.baseUrl,
  });
}

setInterval(refreshAllQuotas, proxyConfig.quota.refreshIntervalMs);
// Initial quota refresh on startup
refreshAllQuotas();
startQuotaWindowActivationScheduler(createWindowActivationRuntime(codexAccountManager));

const PORT = Number(process.env.PORT || 3000);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "*",
};

function json(data: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function jsonError(message: string, status = 400, code = "invalid_request", extra: Record<string, any> = {}): Response {
  return json({
    error: {
      message,
      type: status >= 500 ? "api_error" : "invalid_request_error",
      code,
      ...extra,
    },
  }, status, { "X-Antigravity-Attempts": "0" });
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const cleanPath = url.pathname.replace(/\/+/g, "/");
    console.log(`[${new Date().toISOString()}] ${req.method} ${cleanPath} - Agent: ${req.headers.get("user-agent")}`);

    if (req.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            }
        });
    }
    if (cleanPath === "/oauth/start") {
      return Response.redirect(generateAuthUrl());
    }

    if (cleanPath === "/v1/models") {
        const models = SUPPORTED_MODELS.map(model => ({
            id: model.id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "antigravity",
            name: model.name,
            thinking_levels: model.thinkingLevels,
            default_thinking_level: model.defaultThinkingLevel
        }));
        const codexModels = (getProxyConfig().codex?.models || []).map(model => ({
            id: model,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "codex",
            name: model,
        }));

        return json({
            object: "list",
            data: [...models, ...codexModels]
        });
    }

    if (cleanPath === "/v1/chat/completions" && req.method === "POST") {
      let openaiBody: any;
      try {
        openaiBody = await req.json();
      } catch {
        return jsonError("Invalid JSON in request body", 400);
      }
      const completionRequest = adaptChatCompletionRequest(openaiBody);
      const validationError = validateCompletionRequestForGoogle(completionRequest);
      if (validationError) {
        return jsonError(validationError, 400);
      }

      const requestId = "chatcmpl-" + Math.random().toString(36).substring(7);
      const requestStartedAt = Date.now();
      const sessionIdentity = resolveSessionIdentity(req.headers, openaiBody);
      const execution = await executeCompletion({
        request: completionRequest,
        sessionIdentity,
        requestId,
        requestStartedAt,
        signal: req.signal,
      });

      if (execution.kind === "error") {
        return execution.response;
      }

      if (execution.kind === "stream") {
        return new Response(execution.stream.pipeThrough(createChatCompletionStreamEncoder()), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...CORS_HEADERS,
            "X-Antigravity-Attempts": execution.attempts.toString()
          }
        });
      }

      const finalResponse = encodeChatCompletionResult(requestId, completionRequest.model, execution.result);
      return json(finalResponse, 200, {
        "X-Antigravity-Attempts": execution.attempts.toString()
      });
    }

    if (cleanPath === "/v1/responses" && req.method === "POST") {
      let responsesBody: any;
      try {
        responsesBody = await req.json();
      } catch {
        return jsonError("Invalid JSON in request body", 400);
      }
      const modelRoute = resolveCodexModel(responsesBody?.model, getProxyConfig().codex?.models || []);
      if (modelRoute.provider === "codex") {
        if (!getProxyConfig().codex.enabled) {
          return json({ error: { message: "Codex routing is disabled", type: "service_unavailable" } }, 503);
        }
        const requestId = "resp_" + Math.random().toString(36).substring(2, 14);
        const requestStartedAt = Date.now();
        const sessionIdentity = resolveCodexAffinityIdentity(req.headers, responsesBody);
        return createCodexProxyService().responses({
          body: responsesBody,
          model: modelRoute.upstreamModel,
          identity: sessionIdentity,
          threadId: req.headers.get("thread-id")?.trim() || undefined,
          requestId,
          requestStartedAt,
          signal: req.signal,
        });
      }
      const responsesValidationError = validateResponsesRequest(responsesBody);
      if (responsesValidationError) {
        return jsonError(responsesValidationError, 400);
      }

      const completionRequest = adaptResponsesRequest(responsesBody);
      const completionValidationError = validateCompletionRequestForGoogle(completionRequest);
      if (completionValidationError) {
        return jsonError(completionValidationError, 400);
      }

      const responseId = "resp_" + Math.random().toString(36).substring(2, 14);
      const createdAt = Math.floor(Date.now() / 1000);
      const requestStartedAt = Date.now();
      const sessionIdentity = resolveCodexAffinityIdentity(req.headers, responsesBody, completionRequest.messages);
      const execution = await executeCompletion({
        request: completionRequest,
        sessionIdentity,
        requestId: responseId,
        requestStartedAt,
        signal: req.signal,
      });

      if (execution.kind === "error") {
        return execution.response;
      }

      if (execution.kind === "stream") {
        return new Response(execution.stream.pipeThrough(createResponsesStreamEncoder({
          responseId,
          model: completionRequest.model,
          createdAt,
          requestBody: responsesBody,
        })), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...CORS_HEADERS,
            "X-Antigravity-Attempts": execution.attempts.toString()
          }
        });
      }

      return json(encodeResponsesResult({
        responseId,
        createdAt,
        requestBody: responsesBody,
        result: execution.result,
      }), 200, {
        "X-Antigravity-Attempts": execution.attempts.toString()
      });
    }

    if (cleanPath === "/v1/responses/compact" && req.method === "POST") {
      let compactBody: any;
      try {
        compactBody = await req.json();
      } catch {
        return jsonError("Invalid JSON in request body", 400);
      }
      if (typeof compactBody?.model !== "string" || compactBody.model.trim().length === 0) {
        return jsonError("model is required", 400);
      }
      if (compactBody?.stream === true) {
        return jsonError("Streaming not supported for compact responses", 400);
      }
      const modelRoute = resolveCodexModel(compactBody?.model, getProxyConfig().codex?.models || []);
      if (modelRoute.provider !== "codex") {
        return jsonError("Compact responses are currently supported only for Codex models", 400);
      }
      if (!getProxyConfig().codex.enabled) {
        return json({ error: { message: "Codex routing is disabled", type: "service_unavailable" } }, 503);
      }
      const requestId = "compact_" + Math.random().toString(36).substring(2, 14);
      const requestStartedAt = Date.now();
      const sessionIdentity = resolveCodexAffinityIdentity(req.headers, compactBody);
      return createCodexProxyService().compact({
        body: compactBody,
        model: modelRoute.upstreamModel,
        identity: sessionIdentity,
        threadId: req.headers.get("thread-id")?.trim() || undefined,
        requestId,
        requestStartedAt,
        signal: req.signal,
      });
    }

    if (cleanPath === "/api/sse") {
        let pingTimer: any;
        let cleaned = false;
        let onUpdate: (data: any) => void;
        let onFlash: (data: { email: string, status: 'success' | 'error' }) => void;
        let onLog: (msg: string) => void;
        let onCooldown: (data: any) => void;

        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (pingTimer) clearInterval(pingTimer);
            if (onUpdate) eventBus.off("update", onUpdate);
            if (onFlash) eventBus.off("flash", onFlash);
            if (onLog) eventBus.off("log", onLog);
            if (onCooldown) eventBus.off("cooldown", onCooldown);
        };

        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                
                const send = (event: string, data: any) => {
                    try {
                        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                    } catch (e) {
                        cleanup();
                    }
                };

                pingTimer = setInterval(() => {
                    try {
                        controller.enqueue(encoder.encode(": ping\n\n"));
                    } catch (e) {
                        cleanup();
                    }
                }, 15000);

                send("init", {
                    version: APP_VERSION,
                    accounts: getAccounts(),
                    supportedModels: getSupportedModelIds(),
                    codexModels: getCodexModelIds(),
                    cooldowns: getCooldowns(),
                    logs: logBuffer
                });

                onUpdate = (data: any) => send("update", { ...data, supportedModels: getSupportedModelIds(), codexModels: getCodexModelIds() });
                onFlash = (data: { email: string, status: 'success' | 'error' }) => send("flash", data);
                onLog = (msg: string) => send("log", { message: msg });
                onCooldown = (data: any) => send("cooldown", data);

                eventBus.on("update", onUpdate);
                eventBus.on("flash", onFlash);
                eventBus.on("log", onLog);
                eventBus.on("cooldown", onCooldown);

                req.signal.addEventListener("abort", cleanup, { once: true });
            },
            cancel() {
                cleanup();
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                ...CORS_HEADERS,
            }
        });
    }

    if (cleanPath === "/api/session-bindings" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") || 200);
        const offset = Number(url.searchParams.get("offset") || 0);
        const search = url.searchParams.get("search") || undefined;
        const result = listSessionBindings({ limit, offset, search });
        return json(result);
    }

    if (cleanPath === "/api/request-usage" && req.method === "GET") {
        const optionalTimestamp = (name: string): number | undefined => {
            const raw = url.searchParams.get(name);
            if (!raw) return undefined;
            const value = Number(raw);
            return Number.isFinite(value) ? value : undefined;
        };
        const result = listRequestTokenUsage({
            limit: Number(url.searchParams.get("limit") || 200),
            offset: Number(url.searchParams.get("offset") || 0),
            search: url.searchParams.get("search") || undefined,
            model: url.searchParams.get("model") || undefined,
            sessionKey: url.searchParams.get("session_key") || undefined,
            from: optionalTimestamp("from"),
            to: optionalTimestamp("to"),
        });
        return json(result);
    }

    if (cleanPath === "/api/request-usage" && req.method === "DELETE") {
        const removed = clearRequestTokenUsage();
        console.log(`[Usage] Cleared ${removed} persisted request usage records via API.`);
        return json({ removed });
    }

    if (cleanPath === "/api/session-bindings" && req.method === "DELETE") {
        const removed = clearSessionBindings();
        console.log(`[Sessions] Cleared ${removed} persisted bindings via API.`);
        return json({ removed });
    }

    if (cleanPath.startsWith("/api/session-bindings/") && req.method === "DELETE") {
        const id = Number(cleanPath.slice("/api/session-bindings/".length));
        if (!Number.isSafeInteger(id) || id <= 0) {
            return json({ error: "Invalid binding ID" }, 400);
        }
        const removed = deleteSessionBinding(id);
        return json({ removed }, removed ? 200 : 404);
    }

    if (cleanPath === "/api/codex/accounts" && req.method === "GET") {
        return json({ accounts: codexAccountManager.listPublic() });
    }

    if (cleanPath === "/api/codex/usage" && req.method === "GET") {
        const usageSnapshots = await codexAccountManager.getUsageSnapshots();
        const publicAccountsByEmail = new Map(codexAccountManager.listPublic().map(account => [account.email, account]));
        const accounts = usageSnapshots.map(snapshot => ({
            ...publicAccountsByEmail.get(snapshot.email),
            ...snapshot,
        }));
        return json({ accounts, generatedAt: Date.now() }, 200, { "Cache-Control": "no-store" });
    }

    if (cleanPath.startsWith("/api/codex/accounts/") && req.method === "DELETE") {
        const email = decodeURIComponent(cleanPath.slice("/api/codex/accounts/".length));
        const removed = email ? await codexAccountManager.remove(email) : false;
        return json({ removed }, removed ? 200 : 404);
    }

    if (cleanPath === "/api/codex/auth/device/start" && req.method === "POST") {
        try {
            const state = await codexDeviceAuthService.start();
            return json(state);
        } catch (error: any) {
            return json({ error: error?.message || "Failed to start Codex device login" }, 502);
        }
    }

    if (cleanPath.startsWith("/api/codex/auth/device/") && req.method === "GET") {
        const loginId = cleanPath.slice("/api/codex/auth/device/".length);
        const state = codexDeviceAuthService.get(loginId);
        return json(state || { error: "Device login not found" }, state ? 200 : 404);
    }

    if (cleanPath.startsWith("/api/codex/auth/device/") && req.method === "DELETE") {
        const loginId = cleanPath.slice("/api/codex/auth/device/".length);
        const cancelled = codexDeviceAuthService.cancel(loginId);
        return json({ cancelled }, cancelled ? 200 : 404);
    }

    if (cleanPath === "/api/status") {
        return json({
            version: APP_VERSION,
            accounts: getAccounts(),
            codexAccounts: codexAccountManager.listPublic(),
            supportedModels: getSupportedModelIds(),
            codexModels: getCodexModelIds()
        });
    }

    if (cleanPath === "/api/config" && req.method === "GET") {
        return json(getProxyConfig());
    }

    if (cleanPath === "/api/config" && req.method === "POST") {
        try {
            const body = await req.json() as any;
            const updated = await updateProxyConfig(body);
            return json(updated);
        } catch (e: any) {
            return json({ error: e.message }, 400);
        }
    }

    if (cleanPath === "/api/accounts/reset-all" && req.method === "POST") {
        const accounts = getAccounts();
        for (const acc of accounts) {
            acc.healthScore = 100;
            acc.consecutiveFailures = 0;
            acc.cooldowns = {};
            acc.modelScores = {};
            acc.history = [];
            acc.quota = [];
            delete acc.challenge;
        }
        
        await resetAllCooldowns();
        
        await saveAccounts(accounts);
        console.log(`[Manager] Reset state for all ${accounts.length} accounts via API`);
        return new Response("OK", { status: 200, headers: CORS_HEADERS });
    }

    if (cleanPath.startsWith("/api/accounts/") && req.method === "DELETE") {
        const email = cleanPath.replace("/api/accounts/", "");
        if (email) {
            await removeAccount(email);
            return new Response("OK", { status: 200, headers: CORS_HEADERS });
        }
        return new Response("Bad Request", { status: 400, headers: CORS_HEADERS });
    }

    if (cleanPath.startsWith("/api/accounts/") && cleanPath.endsWith("/reset") && req.method === "POST") {
        const email = cleanPath.split("/")[3];
        await resetAccount(email);
        return new Response("OK", { status: 200, headers: CORS_HEADERS });
    }

    if (cleanPath.startsWith("/api/accounts/") && cleanPath.endsWith("/project/rediscover") && req.method === "POST") {
        const email = cleanPath.split("/")[3];
        const accounts = getAccounts();
        const account = accounts.find(a => a.email === email);
        if (account && account.accessToken) {
            try {
                const newProjectId = await getProjectId(account.accessToken);
                if (newProjectId) {
                    await updateAccountProject(email, newProjectId);
                    return json({ projectId: newProjectId });
                }
                return new Response("No project found via discovery", { status: 404, headers: CORS_HEADERS });
            } catch (e: any) {
                return new Response(e.message, { status: 500, headers: CORS_HEADERS });
            }
        }
        return new Response("Account not found or no token", { status: 400, headers: CORS_HEADERS });
    }

    if (cleanPath.startsWith("/api/accounts/") && cleanPath.endsWith("/project") && req.method === "POST") {
        const email = cleanPath.split("/")[3];
        try {
            const body = await req.json() as any;
            if (body.projectId) {
                await updateAccountProject(email, body.projectId);
                return new Response("OK", { status: 200, headers: CORS_HEADERS });
            }
            return new Response("Missing projectId", { status: 400, headers: CORS_HEADERS });
        } catch {
            return new Response("Bad Request", { status: 400, headers: CORS_HEADERS });
        }
    }

    if (cleanPath.startsWith("/api/accounts/") && cleanPath.endsWith("/cooldown") && req.method === "POST") {
        const email = cleanPath.split("/")[3];
        try {
            const body = await req.json() as any;
            const pool = body.pool || 'cli';
            markCooldown(email, pool as any, "3600s");
            return new Response("OK", { status: 200, headers: CORS_HEADERS });
        } catch {
            return new Response("Bad Request", { status: 400, headers: CORS_HEADERS });
        }
    }

    if (cleanPath === "/oauth-callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400, headers: CORS_HEADERS });

      try {
          const tokenRes = await exchangeCode(code);
          const email = await getUserEmail(tokenRes.access_token);
          const projectId = await getProjectId(tokenRes.access_token);

          const newAccount: AntigravityAccount = {
            email,
            refreshToken: tokenRes.refresh_token!,
            accessToken: tokenRes.access_token,
            expiresAt: Date.now() + (tokenRes.expires_in * 1000),
            projectId,
            healthScore: 100,
            lastUsed: 0,
            tokenUsage: 0
          };

          if (!newAccount.refreshToken) {
              return new Response("No refresh token received. Revoke access and try again.", { status: 400, headers: CORS_HEADERS });
          }

          if (newAccount.projectId) {
              const quota = await fetchQuota(newAccount);
              if (quota) {
                  newAccount.quota = quota;
              }
          }

          await addAccount(newAccount);
          
          return Response.redirect(`${new URL(OAUTH_CONFIG.redirectUri).origin}/frontend/index.html`);
      } catch (e) {
          return new Response(`Auth error: ${e}`, { status: 500, headers: CORS_HEADERS });
      }
    }

    if (cleanPath.startsWith("/frontend/")) {
        const path = cleanPath.replace("/frontend/", "");
        try {
            const file = Bun.file(`${import.meta.dir}/frontend/${path}`);
            return new Response(file);
        } catch {
            return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
        }
    }
    
    if (cleanPath === "/") {
        return Response.redirect("/frontend/index.html");
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
});

console.log(`Antigravity Proxy running on http://127.0.0.1:${PORT}`);
