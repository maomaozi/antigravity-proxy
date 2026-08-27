import {
  emitAccountFlash,
  ensureFingerprint,
  flagAccountChallenge,
  flagModelUnsupported,
  getAccounts,
  getBestAccount,
  getEarliestReset,
  getFamilyName,
  markCooldown,
  updateAccountUsage,
} from "../auth/manager";
import { getProxyConfig } from "../config/manager";
import type { CompletionRequest, CompletionResult, CompletionStreamEvent } from "../core/completion";
import { collectCompletionStream } from "../core/completion";
import type { SessionIdentity } from "../session/identity";
import { getSessionBinding, recordRequestTokenUsage, recordSessionBinding } from "../session/store";
import { parseGoogleError } from "../utils/errors";
import { getGeminiCliHeaders, getImpersonationHeaders } from "../utils/headers";
import {
  createCompletionStreamTransformer,
  transformCompletionToGoogleBody,
  type UpstreamTokenUsage,
} from "../utils/transform";

export type CompletionExecution =
  | { kind: "stream"; stream: ReadableStream<CompletionStreamEvent>; attempts: number }
  | { kind: "result"; result: CompletionResult; attempts: number }
  | { kind: "error"; response: Response };

export interface CompletionExecutionInput {
  request: CompletionRequest;
  sessionIdentity: SessionIdentity;
  requestId: string;
  requestStartedAt: number;
}

function jsonError(status: number, body: any, attempts: number): CompletionExecution {
  return {
    kind: "error",
    response: new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Antigravity-Attempts": attempts.toString(),
      },
    }),
  };
}

export async function executeCompletion({
  request,
  sessionIdentity,
  requestId,
  requestStartedAt,
}: CompletionExecutionInput): Promise<CompletionExecution> {
  const modelLower = request.model.toLowerCase();
  const isClaudeModel = modelLower.includes("claude");
  const isGptModel = modelLower.includes("gpt");

  let useCliPool: boolean;
  if (isClaudeModel || isGptModel) {
    useCliPool = false;
  } else {
    const isAntigravityThinking = modelLower.includes("antigravity")
      && (modelLower.includes("thinking-high")
        || modelLower.includes("thinking-medium")
        || modelLower.includes("thinking-low"));
    const isExplicitAntigravity = modelLower.includes("antigravity-");
    const isExplicitSandboxModel = isAntigravityThinking
      || isExplicitAntigravity
      || modelLower.includes("image");

    useCliPool = !isExplicitSandboxModel && (
      modelLower.includes("-preview")
      || modelLower.includes("gemini-2.0")
      || modelLower.includes("gemini-2.5")
      || (modelLower.includes("gemini-3") && !modelLower.includes("flash"))
    );
  }

  let attempts = 0;
  let aggressive = false;
  const config = getProxyConfig();
  const availableAccountsCount = getAccounts().length;
  const maxAttempts = Math.max(config.retry.maxAttempts, availableAccountsCount);
  const triedEmails: string[] = [];
  const attemptLogs: Array<{ email: string; status: number; reason: string }> = [];
  let systemicErrorCount = 0;

  // GPT and explicit antigravity-* model IDs use the sandbox pool only.
  const isExplicitAntigravity = modelLower.includes("antigravity-");
  const isSandboxOnlyModel = modelLower.includes("gpt") || isExplicitAntigravity;
  const isCliOnlyModel = false;

  const sessionId = sessionIdentity.key;
  const existingBinding = getSessionBinding(sessionIdentity.key, request.model);
  if (existingBinding && !isSandboxOnlyModel && !isCliOnlyModel) {
    useCliPool = existingBinding.pool === "cli";
  }
  console.log(
    `[Session] ${sessionIdentity.source} ${sessionIdentity.id.slice(0, 24)}`
      + `${sessionIdentity.id.length > 24 ? "..." : ""}`
      + `${existingBinding ? ` bound to ${existingBinding.accountEmail}/${existingBinding.pool}` : " (new)"}`,
  );

  let lastStatus = 0;

  while (attempts < maxAttempts) {
    attempts++;

    if (attempts > 1) {
      const delayMs = Math.min(500 * attempts, 3000);
      await new Promise(resolve => setTimeout(resolve, delayMs));

      if (!isSandboxOnlyModel && !isCliOnlyModel && lastStatus !== 503) {
        useCliPool = !useCliPool;
        console.log(`[Switch] Switching to ${useCliPool ? "CLI" : "Sandbox"} pool for attempt ${attempts}`);
      } else {
        console.log(`[Switch] Skipping pool switch for ${isCliOnlyModel ? "CLI-only" : "sandbox-only"} model (attempt ${attempts})`);
      }
    }

    let account = await getBestAccount(
      useCliPool ? "cli" : "sandbox",
      request.model,
      sessionIdentity.key,
      triedEmails,
      true,
    );

    if (!account && !isSandboxOnlyModel && !isCliOnlyModel) {
      console.log(`[Manager] No READY accounts in ${useCliPool ? "CLI" : "Sandbox"} pool, trying the other pool first...`);
      const otherPool = useCliPool ? "sandbox" : "cli";
      account = await getBestAccount(otherPool, request.model, sessionIdentity.key, triedEmails, true);
      if (account) {
        useCliPool = !useCliPool;
        console.log(`[Switch] Found ready account in ${useCliPool ? "CLI" : "Sandbox"} pool.`);
      }
    }

    if (!account) {
      account = await getBestAccount(
        useCliPool ? "cli" : "sandbox",
        request.model,
        sessionIdentity.key,
        triedEmails,
        false,
      );
    }

    if (!account || !account.accessToken) {
      if (attempts < maxAttempts) {
        console.log("[Switch] Exhausted all accounts in both pools, retrying...");
        triedEmails.length = 0;
        continue;
      }
      break;
    }

    const sandboxEndpoints = Array.isArray(config.endpoints.sandbox)
      ? config.endpoints.sandbox
      : [config.endpoints.sandbox];
    const cliEndpoints = Array.isArray(config.endpoints.cli)
      ? config.endpoints.cli
      : [config.endpoints.cli];

    let googleUrl: string;
    const boundEndpointIsUsable = attempts === 1
      && existingBinding?.pool === (useCliPool ? "cli" : "sandbox")
      && !!existingBinding.endpoint
      && (useCliPool ? cliEndpoints : sandboxEndpoints).includes(existingBinding.endpoint);
    if (boundEndpointIsUsable) {
      googleUrl = existingBinding.endpoint!;
    } else if (useCliPool) {
      const cliEndpointIndex = isClaudeModel
        ? cliEndpoints.length - 1
        : Math.min(attempts - 1, cliEndpoints.length - 1);
      googleUrl = cliEndpoints[cliEndpointIndex];
    } else {
      const sandboxEndpointIndex = Math.min(attempts - 1, sandboxEndpoints.length - 1);
      googleUrl = sandboxEndpoints[sandboxEndpointIndex];
    }

    if (lastStatus === 503) {
      console.log(`[Capacity] Retrying account ${account.email} on next endpoint ${googleUrl.split("/")[2]}...`);
    } else {
      triedEmails.push(account.email);
    }

    if (isClaudeModel && !googleUrl.includes("v1internal")) {
      console.warn(`[Warning] Claude model ${request.model} is being routed to a non-v1internal endpoint: ${googleUrl}`);
    }

    const effectiveProjectId = account.projectId!;
    ensureFingerprint(account);
    const googleBody = transformCompletionToGoogleBody(
      request,
      effectiveProjectId,
      useCliPool,
      "",
      sessionId,
      aggressive,
    );

    const isClaudeModelTarget = googleBody.model.toLowerCase().includes("claude");
    const headers = (useCliPool && !isClaudeModelTarget)
      ? getGeminiCliHeaders(account.accessToken!, account.fingerprint!)
      : getImpersonationHeaders(account.accessToken!, account.fingerprint!, googleBody.model);

    console.log(
      `[Request] Model: ${request.model} | Account: ${account.email} | Project: ${effectiveProjectId}`
        + ` | Attempt: ${attempts}/${maxAttempts} | Pool: ${useCliPool ? "CLI" : "Sandbox"}`
        + ` | Endpoint: ${googleUrl.split("/")[2]} | Target Model: ${googleBody.model}`,
    );

    const timeoutKey = Object.keys(config.models.timeouts || {})
      .find(key => request.model.toLowerCase().includes(key)) || "default";
    const timeoutMs = (config.models.timeouts && config.models.timeouts[timeoutKey]) || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (config.features.jitterEnabled) {
        const jitterMs = config.features.jitterMinMs
          + Math.random() * (config.features.jitterMaxMs - config.features.jitterMinMs);
        await new Promise(resolve => setTimeout(resolve, jitterMs));
      }

      const googleRes = await fetch(googleUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(googleBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!googleRes.ok) {
        const errText = await googleRes.text();
        const parsedError = parseGoogleError(errText);
        const status = googleRes.status;
        lastStatus = status;

        console.error(`[Error] Google API (${account.email}) returned ${status} (${parsedError.reason}):`, errText);
        emitAccountFlash(account.email, "error");
        attemptLogs.push({ email: account.email, status, reason: parsedError.reason });

        if (status === 403 || status === 404) {
          if (parsedError.isChallengeRequired) {
            console.log(`[Auth] ${parsedError.reason} for ${account.email}, flagging pool ${useCliPool ? "cli" : "sandbox"} for family ${getFamilyName(request.model)}.`);
            flagAccountChallenge(account.email, useCliPool ? "cli" : "sandbox", getFamilyName(request.model), {
              type: "CAPTCHA",
              url: parsedError.validationUrl || "https://cloud.google.com/gemini/docs/codeassist/request-license",
              reason: parsedError.reason,
              message: parsedError.message,
            });
            continue;
          }
          if (parsedError.isModelUnsupported) {
            console.log(`[Model] Unsupported model ${request.model} for ${account.email}, marking capability.`);
            flagModelUnsupported(account.email, request.model);
          }
          await updateAccountUsage(account.email, false, request.model, useCliPool ? "cli" : "sandbox", status);
          return jsonError(status, {
            error: { message: `Access denied: ${parsedError.reason}`, type: "access_denied", code: status.toString() },
          }, attempts);
        }

        if (status === 500 || status === 503) {
          systemicErrorCount++;
          if (systemicErrorCount > 2) {
            console.log(`[Systemic] Detected systemic outage (${systemicErrorCount} errors), breaking retry loop.`);
            break;
          }
        }

        let resetSeconds = 0;
        try {
          const errJson = JSON.parse(errText);
          const details = errJson.error?.details || [];
          for (const detail of details) {
            if (detail.metadata?.quotaResetDelay) resetSeconds = parseFloat(detail.metadata.quotaResetDelay);
            if (detail.retryDelay) resetSeconds = parseFloat(detail.retryDelay);
          }
          if (resetSeconds === 0 && errJson.error?.message?.includes("reset after")) {
            const match = errJson.error.message.match(/reset after\s+([0-9\.]+)s/);
            if (match) resetSeconds = parseFloat(match[1]);
          }
        } catch {}

        if (status === 429 && resetSeconds > 0 && resetSeconds <= config.retry.transientRetryThresholdSeconds) {
          console.log(`[Skip] Account ${account.email} transiently limited (${resetSeconds}s), rotating...`);
          account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
          if (account.consecutiveFailures >= 2) {
            await updateAccountUsage(account.email, false, request.model, useCliPool ? "cli" : "sandbox", 429);
          }
          triedEmails.push(account.email);
          continue;
        }

        if (
          status === 400
          && (errText.toLowerCase().includes("tool schema")
            || errText.includes("Invalid JSON payload")
            || errText.toLowerCase().includes("function_declarations"))
          && !aggressive
        ) {
          console.log(`[Schema] Detected tool schema error for ${account.email}, retrying with aggressive cleaning...`);
          aggressive = true;
          attempts--;
          continue;
        }

        if (status === 400) {
          return jsonError(400, {
            error: {
              message: parsedError.message || "Upstream rejected the request as invalid.",
              type: "invalid_request_error",
              code: parsedError.reason,
              attempts: attemptLogs,
            },
          }, attempts);
        }
        aggressive = false;

        await updateAccountUsage(account.email, false, request.model, useCliPool ? "cli" : "sandbox", status);
        if (status === 429) {
          markCooldown(account.email, useCliPool ? "cli" : "sandbox", getFamilyName(request.model));
        }
        continue;
      }

      if (!googleRes.body) {
        if (request.stream) {
          return jsonError(502, { error: { message: "No response body from upstream" } }, attempts);
        }
        throw new Error("No response body");
      }

      if (request.stream) {
        const persistStreamUsage = (usage: UpstreamTokenUsage) => {
          recordRequestTokenUsage({
            requestId,
            identity: sessionIdentity,
            accountEmail: account.email,
            model: request.model,
            modelFamily: getFamilyName(request.model),
            upstreamModel: googleBody.model,
            pool: useCliPool ? "cli" : "sandbox",
            endpoint: googleUrl,
            streamed: true,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            reasoningTokensReported: usage.reasoningTokensReported,
            totalTokens: usage.totalTokens,
            createdAt: requestStartedAt,
          });
        };
        const stream = googleRes.body.pipeThrough(createCompletionStreamTransformer(
          request.model,
          requestId,
          false,
          sessionId,
          persistStreamUsage,
        ));

        recordSessionBinding({
          identity: sessionIdentity,
          accountEmail: account.email,
          model: request.model,
          modelFamily: getFamilyName(request.model),
          pool: useCliPool ? "cli" : "sandbox",
          projectId: effectiveProjectId,
          endpoint: googleUrl,
        });
        await updateAccountUsage(account.email, true, request.model, useCliPool ? "cli" : "sandbox");
        return { kind: "stream", stream, attempts };
      }

      let finalTokenUsage: UpstreamTokenUsage | undefined;
      const completionStream = googleRes.body.pipeThrough(createCompletionStreamTransformer(
        request.model,
        requestId,
        false,
        sessionId,
        usage => { finalTokenUsage = usage; },
      ));
      const result = await collectCompletionStream(completionStream);

      if (!result.text && result.toolCalls.length === 0 && result.finishReason !== "length") {
        console.warn(`[Empty] Account ${account.email} returned empty response for ${request.model}, retrying with another account...`);
        markCooldown(account.email, useCliPool ? "cli" : "sandbox", getFamilyName(request.model), "30s");
        continue;
      }

      recordSessionBinding({
        identity: sessionIdentity,
        accountEmail: account.email,
        model: request.model,
        modelFamily: getFamilyName(request.model),
        pool: useCliPool ? "cli" : "sandbox",
        projectId: effectiveProjectId,
        endpoint: googleUrl,
      });
      if (finalTokenUsage) {
        recordRequestTokenUsage({
          requestId,
          identity: sessionIdentity,
          accountEmail: account.email,
          model: request.model,
          modelFamily: getFamilyName(request.model),
          upstreamModel: googleBody.model,
          pool: useCliPool ? "cli" : "sandbox",
          endpoint: googleUrl,
          streamed: false,
          inputTokens: finalTokenUsage.inputTokens,
          cachedInputTokens: finalTokenUsage.cachedInputTokens,
          outputTokens: finalTokenUsage.outputTokens,
          reasoningTokens: finalTokenUsage.reasoningTokens,
          reasoningTokensReported: finalTokenUsage.reasoningTokensReported,
          totalTokens: finalTokenUsage.totalTokens,
          createdAt: requestStartedAt,
        });
      }
      await updateAccountUsage(account.email, true, request.model, useCliPool ? "cli" : "sandbox");
      return { kind: "result", result, attempts };
    } catch (error: any) {
      if (error.name === "AbortError") {
        console.error(`[Timeout] Request timed out for ${account.email} after ${timeoutMs}ms`);
        account.healthScore = Math.max(config.scoring.healthRange.min, account.healthScore - 5);
      } else {
        console.error(`Proxy error for ${account.email}:`, error);
      }
      await updateAccountUsage(account.email, false, request.model, useCliPool ? "cli" : "sandbox");
      attemptLogs.push({ email: account.email || "unknown", status: 500, reason: error.message });
      if (attempts < maxAttempts) continue;
      return jsonError(500, { error: { message: `Proxy exception: ${error.message}` } }, attempts);
    }
  }

  const resetTime = getEarliestReset(useCliPool ? "cli" : "sandbox");
  const resetMsg = resetTime ? ` Next reset in ${resetTime}.` : "";
  return jsonError(429, {
    error: {
      message: `Quota Exhausted: All accounts failed or are exhausted for this model.${resetMsg} Try a different model or wait for quota reset.`,
      type: "insufficient_quota",
      code: "insufficient_quota",
      attempts: attemptLogs,
    },
  }, attempts);
}
