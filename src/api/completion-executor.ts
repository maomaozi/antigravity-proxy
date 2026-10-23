import {
  emitAccountFlash,
  ensureFingerprint,
  flagAccountChallenge,
  flagModelUnsupported,
  getAccounts,
  getAccountSelectionFailure,
  getBestAccount,
  getEarliestReset,
  getFamilyName,
  markCooldown,
  updateAccountUsage,
} from "../auth/manager";
import { getProxyConfig } from "../config/manager";
import type { AntigravityAccount } from "../auth/types";
import type { CompletionRequest, CompletionResult, CompletionStreamEvent } from "../core/completion";
import { collectCompletionStream } from "../core/completion";
import type { SessionIdentity } from "../session/identity";
import { getSessionBinding, recordRequestTokenUsage, recordSessionBinding } from "../session/store";
import { parseGoogleError } from "../utils/errors";
import { getImpersonationHeaders } from "../utils/headers";
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
  signal?: AbortSignal;
}

export interface ResolvedTimeouts {
  firstByteMs: number;
  streamMs: number;
}

export function resolveTimeouts(model: string, timeoutsConfig?: Record<string, number>): ResolvedTimeouts {
  const timeouts = timeoutsConfig || {};
  const defaultFirstByte = 120_000;
  const defaultStream = 900_000;

  const streamMs = typeof timeouts.stream === "number" && timeouts.stream > 0
    ? timeouts.stream
    : defaultStream;

  const matchedKeys = Object.keys(timeouts)
    .filter(key => key !== "stream" && key !== "firstByte" && key !== "default" && model.toLowerCase().includes(key))
    .sort((a, b) => b.length - a.length);
  const modelKey = matchedKeys[0];

  let firstByteMs: number;
  if (modelKey && typeof timeouts[modelKey] === "number" && timeouts[modelKey] > 0) {
    firstByteMs = timeouts[modelKey];
  } else if (typeof timeouts.firstByte === "number" && timeouts.firstByte > 0) {
    firstByteMs = timeouts.firstByte;
  } else if (typeof timeouts.default === "number" && timeouts.default > 0) {
    firstByteMs = timeouts.default;
  } else {
    firstByteMs = defaultFirstByte;
  }

  return { firstByteMs, streamMs };
}

function extractEffort(reasoningEffort?: string, model?: string): string | null {
  if (typeof reasoningEffort === "string" && reasoningEffort.trim()) {
    return reasoningEffort.trim().toLowerCase();
  }
  if (typeof model === "string") {
    const match = model.match(/-(?:thinking-)?(low|medium|high)$/i);
    if (match) return match[1].toLowerCase();
  }
  return null;
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

export interface CompletionAttempt {
  email: string;
  status: number;
  reason: string;
}

export function buildCompletionFailure(
  model: string,
  pool: "sandbox",
  attempts: number,
  attemptLogs: CompletionAttempt[],
): CompletionExecution {
  // An upstream failure is stronger evidence than the resulting account cooldown.
  const lastFailure = attemptLogs.at(-1);
  const reason = lastFailure?.reason || getAccountSelectionFailure(pool, model);
  let status = 503;
  let type = "server_error";
  let code = reason;
  let message = `No available accounts for model '${model}'. Check account authentication and availability.`;
  if (reason === "model_not_found") {
    status = 404;
    type = "invalid_request_error";
    message = `Model '${model}' is unavailable for the configured accounts. Select another model.`;
  } else if (reason === "no_accounts") {
    message = "No accounts with credentials are configured. Add or authenticate an account.";
  } else if (["account_verification_required", "validation_required", "subscription_required"].includes(reason)) {
    status = 403;
    type = "access_denied";
    code = "account_verification_required";
    message = `Accounts for model '${model}' require verification or a subscription. Check the account dashboard.`;
  } else if (reason === "insufficient_quota" || reason === "quota_exhausted") {
    status = 429;
    type = "insufficient_quota";
    code = "insufficient_quota";
    const resetTime = getEarliestReset(pool);
    message = `Quota exhausted for model '${model}'.${resetTime ? ` Next reset in ${resetTime}.` : ""} Try another model or wait for quota reset.`;
  } else if (reason === "rate_limit_exceeded" || lastFailure?.status === 429) {
    status = 429;
    type = "rate_limit_error";
    code = "rate_limit_exceeded";
    message = `Accounts for model '${model}' are temporarily rate limited or cooling down. Retry later.`;
  } else if (lastFailure) {
    status = lastFailure.status >= 500 ? lastFailure.status : 502;
    code = "upstream_error";
    message = `Upstream request failed for model '${model}' (HTTP ${lastFailure.status}: ${reason}). Retry later.`;
  }
  return jsonError(status, { error: { message, type, code, attempts: attemptLogs } }, attempts);
}

export async function executeCompletion({
  request,
  sessionIdentity,
  requestId,
  requestStartedAt,
  signal,
}: CompletionExecutionInput): Promise<CompletionExecution> {
  const modelLower = request.model.toLowerCase();
  const isClaudeModel = modelLower.includes("claude");
  let attempts = 0;
  let aggressive = false;
  const config = getProxyConfig();
  const availableAccountsCount = getAccounts().length;
  const maxAttempts = Math.max(config.retry.maxAttempts, availableAccountsCount);
  const triedEmails: string[] = [];
  const attemptLogs: CompletionAttempt[] = [];
  let systemicErrorCount = 0;
  let invalidArgumentRetried = false;
  let invalidArgumentRetry: { account: AntigravityAccount; endpoint: string } | undefined;

  const sessionId = sessionIdentity.key;
  const routingKey = sessionIdentity.source === "thread-id" ? sessionIdentity.id : undefined;
  const existingBinding = getSessionBinding(sessionIdentity.key, request.model);
  console.log(
    `[Session] ${sessionIdentity.source} ${sessionIdentity.id.slice(0, 24)}`
      + `${sessionIdentity.id.length > 24 ? "..." : ""}`
      + `${existingBinding ? ` bound to ${existingBinding.accountEmail}/${existingBinding.pool}` : " (new)"}`,
  );

  let lastStatus = 0;

  while (attempts < maxAttempts) {
    if (signal?.aborted) {
      throw new DOMException("Request was aborted by the client", "AbortError");
    }
    attempts++;

    if (attempts > 1) {
      const delayMs = Math.min(500 * attempts, 3000);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    const pendingInvalidArgumentRetry = invalidArgumentRetry;
    invalidArgumentRetry = undefined;
    let account = pendingInvalidArgumentRetry?.account ?? await getBestAccount(
      "sandbox",
      request.model,
      sessionIdentity.key,
      triedEmails,
      true,
      routingKey,
      signal,
    );

    if (!account) {
      account = await getBestAccount(
        "sandbox",
        request.model,
        sessionIdentity.key,
        triedEmails,
        false,
        routingKey,
        signal,
      );
    }

    if (!account || !account.accessToken) {
      // Selection already tried ready accounts and rescue. Preserve why it failed.
      break;
    }

    const sandboxEndpoints = Array.isArray(config.endpoints.sandbox)
      ? config.endpoints.sandbox
      : [config.endpoints.sandbox];

    let googleUrl: string;
    const boundEndpointIsUsable = attempts === 1
      && existingBinding?.pool === "sandbox"
      && !!existingBinding.endpoint
      && sandboxEndpoints.includes(existingBinding.endpoint);
    if (pendingInvalidArgumentRetry) {
      googleUrl = pendingInvalidArgumentRetry.endpoint;
    } else if (boundEndpointIsUsable) {
      googleUrl = existingBinding.endpoint!;
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
      "",
      sessionId,
      aggressive,
    );

    const headers = getImpersonationHeaders(account.accessToken!, account.fingerprint!, googleBody.model);

    console.log(
      `[Request] Model: ${request.model} | Account: ${account.email} | Project: ${effectiveProjectId}`
        + ` | Attempt: ${attempts}/${maxAttempts} | Pool: Sandbox`
        + ` | Endpoint: ${googleUrl.split("/")[2]} | Target Model: ${googleBody.model}`,
    );

    if (signal?.aborted) {
      throw new DOMException("Request was aborted by the client", "AbortError");
    }

    const { firstByteMs, streamMs } = resolveTimeouts(request.model, config.models.timeouts);
    const attemptController = new AbortController();
    let cleanupClientAbort: (() => void) | undefined;
    if (signal) {
      const onClientAbort = () => {
        attemptController.abort(signal.reason);
      };
      signal.addEventListener("abort", onClientAbort, { once: true });
      cleanupClientAbort = () => {
        signal.removeEventListener("abort", onClientAbort);
      };
    }

    let isFirstByteTimedOut = false;
    let isStreamTimedOut = false;

    let firstByteTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      isFirstByteTimedOut = true;
      attemptController.abort(new DOMException(`First byte timed out after ${firstByteMs}ms`, "TimeoutError"));
    }, firstByteMs);

    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = undefined;
      }
      cleanupClientAbort?.();
      cleanupClientAbort = undefined;
    };

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
        signal: attemptController.signal,
      });

      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }

      if (!googleRes.ok) {
        clearTimers();
        const errText = await googleRes.text();
        const parsedError = parseGoogleError(errText);
        const status = googleRes.status;
        lastStatus = status;

        console.error(`[Error] Google API (${account.email}) returned ${status} (${parsedError.reason}):`, errText);
        emitAccountFlash(account.email, "error");
        attemptLogs.push({ email: account.email, status, reason: parsedError.reason });

        if (status === 403 || status === 404) {
          if (parsedError.isChallengeRequired) {
            console.log(`[Auth] ${parsedError.reason} for ${account.email}, flagging pool sandbox for family ${getFamilyName(request.model)}.`);
            flagAccountChallenge(account.email, "sandbox", getFamilyName(request.model), {
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
            await updateAccountUsage(account.email, false, request.model, "sandbox", status);
            return buildCompletionFailure(request.model, "sandbox", attempts, attemptLogs);
          }
          await updateAccountUsage(account.email, false, request.model, "sandbox", status);
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
            await updateAccountUsage(account.email, false, request.model, "sandbox", 429);
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
          // Some Gemini failures contain only this generic message. Retry the
          // same request once before failing; detailed validation errors still
          // return immediately, and the configured attempt limit still applies.
          let genericInvalidArgument = false;
          try {
            const error = JSON.parse(errText).error;
            genericInvalidArgument = error?.status === "INVALID_ARGUMENT"
              && error?.message?.trim() === "Request contains an invalid argument."
              && (!error.details || (Array.isArray(error.details) && error.details.length === 0));
          } catch {}
          if (modelLower.includes("gemini") && genericInvalidArgument && !invalidArgumentRetried && attempts < maxAttempts) {
            invalidArgumentRetried = true;
            invalidArgumentRetry = { account, endpoint: googleUrl };
            console.warn(`[Retry] Gemini returned a generic INVALID_ARGUMENT; retrying the same account and endpoint once (request ${requestId}).`);
            continue;
          }
          console.warn(`[InvalidRequest] Request: ${requestId} | Model: ${googleBody.model} | Contents: ${googleBody.request.contents.length} | Tools: ${request.tools?.length || 0} | Bytes: ${Buffer.byteLength(JSON.stringify(googleBody))}`);
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

        await updateAccountUsage(account.email, false, request.model, "sandbox", status);
        if (status === 429) {
          const cooldownDuration = parsedError.resetSeconds ? `${Math.ceil(parsedError.resetSeconds)}s` : undefined;
          markCooldown(account.email, "sandbox", getFamilyName(request.model), cooldownDuration);
        }
        continue;
      }

      if (!googleRes.body) {
        clearTimers();
        if (request.stream) {
          return jsonError(502, { error: { message: "No response body from upstream" } }, attempts);
        }
        throw new Error("No response body");
      }

      streamTimer = setTimeout(() => {
        isStreamTimedOut = true;
        attemptController.abort(new DOMException(`Stream timed out after ${streamMs}ms`, "TimeoutError"));
      }, streamMs);

      if (request.stream) {
        const persistStreamUsage = (usage: UpstreamTokenUsage) => {
          recordRequestTokenUsage({
            requestId,
            identity: sessionIdentity,
            accountEmail: account.email,
            model: request.model,
            modelFamily: getFamilyName(request.model),
            upstreamModel: googleBody.model,
            pool: "sandbox",
            endpoint: googleUrl,
            streamed: true,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            reasoningTokensReported: usage.reasoningTokensReported,
            effort: extractEffort(request.reasoningEffort, request.model),
            totalTokens: usage.totalTokens,
            createdAt: requestStartedAt,
          });
        };
        const timeoutWatchdog = new TransformStream<Uint8Array, Uint8Array>();
        // pipeTo settles on completion, cancellation, and upstream errors.
        // Handle its rejection here; the readable propagates it to the client.
        void googleRes.body.pipeTo(timeoutWatchdog.writable).then(clearTimers, clearTimers);

        const stream = timeoutWatchdog.readable
          .pipeThrough(createCompletionStreamTransformer(
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
          pool: "sandbox",
          projectId: effectiveProjectId,
          endpoint: googleUrl,
        });
        await updateAccountUsage(account.email, true, request.model, "sandbox");
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
      let result: CompletionResult;
      try {
        result = await collectCompletionStream(completionStream);
      } finally {
        clearTimers();
      }

      if (!result.text && result.toolCalls.length === 0 && result.finishReason !== "length") {
        console.warn(`[Empty] Account ${account.email} returned empty response for ${request.model}, retrying with another account...`);
        attemptLogs.push({ email: account.email, status: 502, reason: "empty_response" });
        markCooldown(account.email, "sandbox", getFamilyName(request.model), "30s");
        continue;
      }

      recordSessionBinding({
        identity: sessionIdentity,
        accountEmail: account.email,
        model: request.model,
        modelFamily: getFamilyName(request.model),
        pool: "sandbox",
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
          pool: "sandbox",
          endpoint: googleUrl,
          streamed: false,
          inputTokens: finalTokenUsage.inputTokens,
          cachedInputTokens: finalTokenUsage.cachedInputTokens,
          outputTokens: finalTokenUsage.outputTokens,
          reasoningTokens: finalTokenUsage.reasoningTokens,
          reasoningTokensReported: finalTokenUsage.reasoningTokensReported,
          effort: extractEffort(request.reasoningEffort, request.model),
          totalTokens: finalTokenUsage.totalTokens,
          createdAt: requestStartedAt,
        });
      }
      await updateAccountUsage(account.email, true, request.model, "sandbox");
      return { kind: "result", result, attempts };
    } catch (error: any) {
      clearTimers();
      if (signal?.aborted) {
        throw error;
      }
      const isTimeout = isFirstByteTimedOut
        || isStreamTimedOut
        || error.name === "TimeoutError"
        || (error.name === "AbortError" && !signal?.aborted);

      if (isTimeout) {
        const timeoutDesc = isStreamTimedOut
          ? `stream after ${streamMs}ms`
          : `first byte after ${firstByteMs}ms`;
        console.error(`[Timeout] Request timed out for ${account.email} (${timeoutDesc})`);
        account.healthScore = Math.max(config.scoring.healthRange.min, account.healthScore - 5);
      } else {
        console.error(`Proxy error for ${account.email}:`, error);
      }
      await updateAccountUsage(account.email, false, request.model, "sandbox");
      attemptLogs.push({ email: account.email || "unknown", status: 500, reason: error.message });
      if (attempts < maxAttempts) continue;
      return jsonError(500, { error: { message: `Proxy exception: ${error.message}` } }, attempts);
    }
  }

  return buildCompletionFailure(request.model, "sandbox", attempts, attemptLogs);
}
