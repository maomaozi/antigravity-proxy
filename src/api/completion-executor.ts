import { findAccountModel } from "../models";
import { ANTIGRAVITY_STREAM_URL } from "./endpoints";
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
  prepareAccountForRequest,
  suspendAccountPool,
  clearAccountPoolSuspension,
  updateAccountUsage,
} from "../auth/manager";
import { getProxyConfig } from "../config/manager";
import type { CompletionRequest, CompletionResult, CompletionStreamEvent } from "../core/completion";
import { collectCompletionStream } from "../core/completion";
import { resolveRoutingGuardKeys, type SessionIdentity } from "../session/identity";
import {
  deleteSessionRoutingGuard,
  findSessionRoutingGuard,
  getSessionBinding,
  recordRequestTokenUsage,
  recordSessionBinding,
  releaseSessionRoutingGuardProbe,
  tryAcquireSessionRoutingGuardProbe,
  upsertSessionRoutingGuard,
  type SessionRoutingGuard,
} from "../session/store";
import { evaluateAccountModelQuotaState, refreshAccountQuotaSingleFlight } from "./quota";
import { parseGoogleError } from "../utils/errors";
import { getAntigravityNativeHeaders } from "../utils/headers";
import {
  createCompletionStreamTransformer,
  transformCompletionToGoogleBody,
  type UpstreamTokenUsage,
} from "../utils/transform";

export const MAX_SAME_ACCOUNT_ORDINARY_ATTEMPTS = 3;
export const MAX_ACCOUNTS_PER_LOGICAL_REQUEST = 2;
export const MIN_429_PROTECTION_RETRY_SECONDS = 60;
export const LOGICAL_REQUEST_BUDGET_RETENTION_MS = 60_000;

const inFlightLogicalRequests = new Map<string, Promise<unknown>>();

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
    firstByteMs = timeouts[firstByteKey()]!;
  } else if (typeof timeouts.default === "number" && timeouts.default > 0) {
    firstByteMs = timeouts.default;
  } else {
    firstByteMs = defaultFirstByte;
  }

  return { firstByteMs, streamMs };
}

function firstByteKey(): "firstByte" {
  return "firstByte";
}

function extractEffort(reasoningEffort?: string, model?: string): string | null {
  if (typeof reasoningEffort === "string" && reasoningEffort.trim()) {
    return reasoningEffort.trim().toLowerCase();
  }
  if (typeof model === "string") {
    const match = model.match(/-(?:thinking-)?(low|medium|high|xhigh)$/i);
    if (match) return match[1]!.toLowerCase();
  }
  return null;
}

function jsonError(
  status: number,
  body: any,
  attempts: number,
  extraHeaders: Record<string, string> = {},
): CompletionExecution {
  return {
    kind: "error",
    response: new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "X-Antigravity-Attempts": attempts.toString(),
        ...extraHeaders,
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
  reasoningEffort?: string,
  extraHeaders: Record<string, string> = {},
): CompletionExecution {
  // An upstream failure is stronger evidence than the resulting account cooldown.
  const lastFailure = attemptLogs.at(-1);
  const reason = lastFailure?.reason || getAccountSelectionFailure(pool, model, reasoningEffort);
  let status = 503;
  let type = "server_error";
  let code: string = reason;
  let message = `No available accounts for model '${model}'. Check account authentication and availability.`;
  if (reason === "invalid_argument") {
    status = 400;
    type = "invalid_request_error";
    message = `Upstream rejected the request for model '${model}' as invalid.`;
  } else if (reason === "model_not_found") {
    status = 404;
    type = "invalid_request_error";
    message = `Model '${model}' is unavailable for the configured accounts. Select another model.`;
  } else if (reason === "no_accounts") {
    message = "No accounts with credentials are configured. Add or authenticate an account.";
  } else if (["tos_violation", "pool_suspended"].includes(reason)) {
    status = 403;
    type = "access_denied";
    code = "pool_suspended";
    message = `Access to the model pool for '${model}' is suspended for the available accounts. Other pools remain available. Check the account dashboard for appeal details.`;
  } else if (reason === "accounts_disabled") {
    message = "All accounts supporting this model are disabled. Enable an account in the dashboard.";
  } else if (["account_verification_required", "validation_required", "subscription_required"].includes(reason)) {
    status = 403;
    type = "access_denied";
    code = "account_verification_required";
    message = `Accounts for model '${model}' require verification or a subscription. Check the account dashboard.`;
  } else if (reason === "insufficient_quota" || reason === "quota_exhausted") {
    status = 429;
    type = "insufficient_quota";
    code = "insufficient_quota";
    const resetTime = getEarliestReset(pool, model);
    message = `Quota exhausted for model '${model}'.${resetTime ? ` Next reset in ${resetTime}.` : ""} Try another model or wait for quota reset.`;
  } else if (reason === "upstream_429_with_quota" || reason === "quota_evidence_conflict") {
    status = 429;
    type = "rate_limit_error";
    code = "upstream_429_with_quota";
    message = `Upstream returned 429 for model '${model}' while account quota remains available. Session stays pinned to avoid cross-account cascade; retry after cooldown.`;
  } else if (reason === "rate_limit_exceeded" || reason === "resource_exhausted" || lastFailure?.status === 429) {
    status = 429;
    type = "rate_limit_error";
    code = "rate_limit_exceeded";
    message = `Accounts for model '${model}' are temporarily rate limited or cooling down. Retry later.`;
  } else if (lastFailure) {
    status = lastFailure.status >= 500 ? lastFailure.status : 502;
    code = "upstream_error";
    message = `Upstream request failed for model '${model}' (HTTP ${lastFailure.status}: ${reason}). Retry later.`;
  }
  return jsonError(status, { error: { message, type, code, attempts: attemptLogs } }, attempts, extraHeaders);
}

function buildProtected429Error(
  model: string,
  guard: SessionRoutingGuard,
  attempts: number,
  attemptLogs: CompletionAttempt[],
  now = Date.now(),
): CompletionExecution {
  const retryAt = guard.retryAt && guard.retryAt > now ? guard.retryAt : now + MIN_429_PROTECTION_RETRY_SECONDS * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
  const code = guard.errorCode || (guard.reason === "upstream_429_with_quota" || guard.reason === "quota_evidence_conflict"
    ? "upstream_429_with_quota"
    : "rate_limit_exceeded");
  const message =
    guard.errorMessage
    || (code === "upstream_429_with_quota"
      ? `Upstream returned 429 for model '${model}' while account quota remains available. Retry after ${retryAfterSeconds}s.`
      : `Account for model '${model}' is rate limited and protected from rotation. Retry after ${retryAfterSeconds}s.`);
  return jsonError(
    429,
    {
      error: {
        message,
        type: "rate_limit_error",
        code,
        reason: guard.reason || code,
        retry_after: retryAfterSeconds,
        retry_at: retryAt,
        attempts: attemptLogs,
      },
    },
    attempts,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

function buildTerminatedTosError(
  model: string,
  guard: SessionRoutingGuard,
  attempts: number,
  attemptLogs: CompletionAttempt[],
): CompletionExecution {
  const code = guard.errorCode || "pool_suspended";
  const message =
    guard.errorMessage
    || `Access to the model pool for '${model}' is suspended for the bound account. Check the account dashboard for appeal details.`;
  return jsonError(
    403,
    {
      error: {
        message,
        type: "access_denied",
        code,
        reason: guard.reason || "tos_violation",
        ...(guard.appealUrl ? { appeal_url: guard.appealUrl } : {}),
        attempts: attemptLogs,
      },
    },
    attempts,
  );
}

export async function executeCompletion({
  request,
  sessionIdentity,
  requestId,
  requestStartedAt,
  signal,
}: CompletionExecutionInput): Promise<CompletionExecution> {
  const modelLower = request.model.toLowerCase();
  const config = getProxyConfig();
  const maxAttempts = Math.max(1, Math.trunc(config.retry.maxAttempts || 1));
  const { sessionScopeKey, digestScopeKey, payloadDigest } = resolveRoutingGuardKeys(sessionIdentity, request);
  const logicalConcurrencyKey = `${sessionScopeKey}|${modelLower}|${payloadDigest}`;

  // If an identical logical request is already in-flight, wait for its guard state
  // or check atomic guard probe immediately so concurrent requests cannot bypass protection.
  const existingInFlight = inFlightLogicalRequests.get(logicalConcurrencyKey);
  if (existingInFlight) {
    const currentGuard = findSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model);
    if (currentGuard?.status === "terminated_tos") {
      return buildTerminatedTosError(request.model, currentGuard, 0, []);
    }
    if (currentGuard?.status === "protected_429") {
      return buildProtected429Error(request.model, currentGuard, 0, []);
    }
    await existingInFlight.catch(() => {});
  }

  let releaseInFlight!: () => void;
  const inFlightPromise = new Promise<void>(resolve => {
    releaseInFlight = resolve;
  });
  inFlightLogicalRequests.set(logicalConcurrencyKey, inFlightPromise);

  try {
    return await executeCompletionInternal({
      request,
      sessionIdentity,
      requestId,
      requestStartedAt,
      signal,
      modelLower,
      maxAttempts,
      sessionScopeKey,
      digestScopeKey,
      payloadDigest,
    });
  } finally {
    releaseInFlight();
    if (inFlightLogicalRequests.get(logicalConcurrencyKey) === inFlightPromise) {
      inFlightLogicalRequests.delete(logicalConcurrencyKey);
    }
  }
}

async function executeCompletionInternal({
  request,
  sessionIdentity,
  requestId,
  requestStartedAt,
  signal,
  modelLower,
  maxAttempts,
  sessionScopeKey,
  digestScopeKey,
  payloadDigest,
}: CompletionExecutionInput & {
  modelLower: string;
  maxAttempts: number;
  sessionScopeKey: string;
  digestScopeKey: string | undefined;
  payloadDigest: string;
}): Promise<CompletionExecution> {
  const config = getProxyConfig();
  const now = Date.now();
  const attemptLogs: CompletionAttempt[] = [];

  // 1. Inspect persistent routing guard before any account selection.
  let guard = findSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model);
  let isPost429Probe = false;

  if (guard) {
    if (guard.status === "terminated_tos") {
      return buildTerminatedTosError(request.model, guard, 0, []);
    }
    if (guard.status === "protected_429") {
      if ((guard.retryAt && guard.retryAt > now) || guard.probeInProgress) {
        return buildProtected429Error(request.model, guard, 0, [], now);
      }
      const acquired = tryAcquireSessionRoutingGuardProbe(
        guard.sessionKey,
        digestScopeKey,
        request.model,
        now,
      );
      if (!acquired) {
        const latestGuard = findSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model) || guard;
        return buildProtected429Error(request.model, latestGuard, 0, [], now);
      }
      isPost429Probe = true;
      guard = findSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model) || guard;
    } else if (
      guard.status === "pinned"
      && guard.requestDigest === payloadDigest
      && guard.budgetExhaustedUntil
      && guard.budgetExhaustedUntil > now
      && guard.attemptsUsed >= maxAttempts
    ) {
      const status = guard.errorStatus || 502;
      const code = guard.errorCode || guard.reason || "upstream_error";
      const message =
        guard.errorMessage
        || `Upstream request failed for model '${request.model}' after exhausting retry budget (${maxAttempts}).`;
      return jsonError(
        status,
        {
          error: {
            message,
            type: status === 400 ? "invalid_request_error" : status === 403 ? "access_denied" : "server_error",
            code,
            attempts: [],
          },
        },
        0,
      );
    }
  }

  const isSameLogicalRequest = Boolean(
    guard
    && guard.requestDigest === payloadDigest
    && !isPost429Probe
    && guard.attemptsUsed > 0
    && guard.attemptsUsed < maxAttempts,
  );
  let totalLogicalAttempts = isSameLogicalRequest ? guard!.attemptsUsed : 0;
  let currentAccountEmail: string | undefined = guard?.accountEmail;
  let currentAccountAttempts = isSameLogicalRequest ? guard!.accountAttemptsUsed : 0;
  const accountsTouched: string[] = isSameLogicalRequest && guard!.accountsTouched.length > 0
    ? [...guard!.accountsTouched]
    : (currentAccountEmail ? [currentAccountEmail] : []);

  const excludedEmails = new Set<string>();
  const refreshed401Emails = new Set<string>();
  if (isSameLogicalRequest && accountsTouched.length > 1) {
    for (const prev of accountsTouched.slice(0, -1)) {
      excludedEmails.add(prev);
    }
  } else if (
    isSameLogicalRequest
    && currentAccountEmail
    && currentAccountAttempts >= MAX_SAME_ACCOUNT_ORDINARY_ATTEMPTS
    && accountsTouched.length < MAX_ACCOUNTS_PER_LOGICAL_REQUEST
  ) {
    excludedEmails.add(currentAccountEmail);
  }

  let localAttempts = 0;
  let aggressive = false;

  const sessionId = sessionIdentity.key;
  const routingKey = sessionIdentity.source === "thread-id" ? sessionIdentity.id : undefined;
  const existingBinding = getSessionBinding(sessionScopeKey, request.model) || getSessionBinding(sessionIdentity.key, request.model);
  const googleUrl = ANTIGRAVITY_STREAM_URL;
  console.log(
    `[Session] ${sessionIdentity.source} ${sessionIdentity.id.slice(0, 24)}`
      + `${sessionIdentity.id.length > 24 ? "..." : ""}`
      + `${existingBinding ? ` bound to ${existingBinding.accountEmail}/${existingBinding.pool}` : " (new)"}`,
  );

  try {
    while (totalLogicalAttempts < maxAttempts && (!isPost429Probe || localAttempts < 1)) {
      if (signal?.aborted) {
        throw new DOMException("Request was aborted by the client", "AbortError");
      }

      if (localAttempts > 0) {
        const delayMs = Math.min(500 * localAttempts, 3000);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      const excludeList = isPost429Probe ? [] : [...excludedEmails];

      let account = await getBestAccount(
        "sandbox",
        request.model,
        sessionScopeKey,
        excludeList,
        true,
        routingKey,
        signal,
        request.reasoningEffort,
      );

      if (!account && !isPost429Probe) {
        // Rescue is only allowed when no protected/pinned account is being held back.
        const currentGuard = findSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model);
        const pinnedEmail = currentGuard?.accountEmail || existingBinding?.accountEmail;
        const canRescue = !pinnedEmail || excludeList.includes(pinnedEmail);
        if (canRescue) {
          account = await getBestAccount(
            "sandbox",
            request.model,
            sessionScopeKey,
            excludeList,
            false,
            routingKey,
            signal,
            request.reasoningEffort,
          );
        }
      }

      if (!account || !account.accessToken) {
        if (isPost429Probe && guard) {
          releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
          isPost429Probe = false;
          return buildProtected429Error(request.model, guard, localAttempts, attemptLogs);
        }
        break;
      }

      if (isPost429Probe && guard && account.email !== guard.accountEmail) {
        // Post-retryAt probe must never switch to another account B.
        releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
        isPost429Probe = false;
        return buildProtected429Error(request.model, guard, localAttempts, attemptLogs);
      }

      // Enforce max 2 accounts per logical request.
      if (
        !accountsTouched.includes(account.email)
        && accountsTouched.length >= MAX_ACCOUNTS_PER_LOGICAL_REQUEST
      ) {
        break;
      }

      localAttempts++;
      totalLogicalAttempts++;
      if (account.email !== currentAccountEmail) {
        currentAccountEmail = account.email;
        currentAccountAttempts = 1;
      } else {
        currentAccountAttempts++;
      }
      if (!accountsTouched.includes(account.email)) {
        accountsTouched.push(account.email);
      }

      // Atomically pin account and record attempt usage BEFORE calling upstream.
      guard = upsertSessionRoutingGuard({
        sessionScopeKey,
        digestScopeKey,
        model: request.model,
        accountEmail: account.email,
        status: isPost429Probe ? "protected_429" : "pinned",
        reason: isPost429Probe ? guard?.reason : null,
        errorCode: isPost429Probe ? guard?.errorCode : null,
        errorStatus: isPost429Probe ? guard?.errorStatus : null,
        errorMessage: isPost429Probe ? guard?.errorMessage : null,
        retryAt: isPost429Probe ? guard?.retryAt : null,
        probeInProgress: isPost429Probe,
        requestDigest: payloadDigest,
        attemptsUsed: totalLogicalAttempts,
        accountAttemptsUsed: currentAccountAttempts,
        accountsTouched,
      });

      const effectiveProjectId = account.projectId!;
      ensureFingerprint(account);
      const googleBody = transformCompletionToGoogleBody(
        request,
        effectiveProjectId,
        "",
        sessionId,
        aggressive,
        findAccountModel(account, request.model, request.reasoningEffort),
      );

      const headers = getAntigravityNativeHeaders(account.accessToken!);

      console.log(
        `[Request] Model: ${request.model} | Account: ${account.email} | Project: ${effectiveProjectId}`
          + ` | Attempt: ${totalLogicalAttempts}/${maxAttempts} (account #${currentAccountAttempts}) | Pool: Sandbox`
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

      const handleOrdinaryFailureOnCurrentAccount = (status: number, reason: string, message?: string) => {
        if (isPost429Probe) {
          releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
          isPost429Probe = false;
          return false;
        }
        if (
          currentAccountAttempts >= MAX_SAME_ACCOUNT_ORDINARY_ATTEMPTS
          && accountsTouched.length < MAX_ACCOUNTS_PER_LOGICAL_REQUEST
        ) {
          excludedEmails.add(account!.email);
        }
        if (totalLogicalAttempts >= maxAttempts) {
          upsertSessionRoutingGuard({
            sessionScopeKey,
            digestScopeKey,
            model: request.model,
            accountEmail: account!.email,
            status: "pinned",
            reason,
            errorCode: "upstream_error",
            errorStatus: status >= 500 ? status : 502,
            errorMessage: message || `Upstream request failed for model '${request.model}' (HTTP ${status}: ${reason}). Retry later.`,
            requestDigest: payloadDigest,
            attemptsUsed: totalLogicalAttempts,
            accountAttemptsUsed: currentAccountAttempts,
            accountsTouched,
            budgetExhaustedUntil: Date.now() + LOGICAL_REQUEST_BUDGET_RETENTION_MS,
          });
          return false;
        }
        if (
          currentAccountAttempts >= MAX_SAME_ACCOUNT_ORDINARY_ATTEMPTS
          && accountsTouched.length >= MAX_ACCOUNTS_PER_LOGICAL_REQUEST
        ) {
          upsertSessionRoutingGuard({
            sessionScopeKey,
            digestScopeKey,
            model: request.model,
            accountEmail: account!.email,
            status: "pinned",
            reason,
            errorCode: "upstream_error",
            errorStatus: status >= 500 ? status : 502,
            errorMessage: message || `Upstream request failed for model '${request.model}' (HTTP ${status}: ${reason}). Retry later.`,
            requestDigest: payloadDigest,
            attemptsUsed: totalLogicalAttempts,
            accountAttemptsUsed: currentAccountAttempts,
            accountsTouched,
            budgetExhaustedUntil: Date.now() + LOGICAL_REQUEST_BUDGET_RETENTION_MS,
          });
          return false;
        }
        return true;
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

          console.error(`[Error] Google API (${account.email}) returned ${status} (${parsedError.reason}):`, errText);
          emitAccountFlash(account.email, "error");
          attemptLogs.push({ email: account.email, status, reason: parsedError.reason });

          // 401: Refresh token on A and retry at most once on A.
          if (status === 401) {
            if (!refreshed401Emails.has(account.email) && !isPost429Probe && totalLogicalAttempts < maxAttempts) {
              refreshed401Emails.add(account.email);
              const refreshed = await prepareAccountForRequest(account.email, true);
              if (refreshed?.accessToken) {
                continue;
              }
            }
            await updateAccountUsage(account.email, false, request.model, "sandbox", 401);
            if (isPost429Probe) {
              releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
              isPost429Probe = false;
            }
            return jsonError(401, {
              error: {
                message: parsedError.message || "Authentication failed after token refresh.",
                type: "authentication_error",
                code: "unauthorized",
                attempts: attemptLogs,
              },
            }, localAttempts);
          }

          if (status === 403 || status === 404) {
            if (status === 403 && parsedError.isServiceSuspended) {
              await suspendAccountPool(account.email, googleBody.model, {
                reason: parsedError.reason,
                message: parsedError.message,
                appealUrl: parsedError.appealUrl,
              });
              const terminatedGuard = upsertSessionRoutingGuard({
                sessionScopeKey,
                digestScopeKey,
                model: request.model,
                accountEmail: account.email,
                status: "terminated_tos",
                reason: "tos_violation",
                errorCode: "pool_suspended",
                errorStatus: 403,
                errorMessage: `Access to the model pool for '${request.model}' is suspended for the available accounts. Other pools remain available. Check the account dashboard for appeal details.`,
                appealUrl: parsedError.appealUrl,
                probeInProgress: false,
                requestDigest: payloadDigest,
                attemptsUsed: totalLogicalAttempts,
                accountAttemptsUsed: currentAccountAttempts,
                accountsTouched,
              });
              isPost429Probe = false;
              console.warn(`[Auth] Isolated Antigravity service for ${account.email} (${parsedError.reason}); stopping rotation for session.`);
              return buildTerminatedTosError(request.model, terminatedGuard, localAttempts, attemptLogs);
            }
            if (parsedError.isChallengeRequired) {
              console.log(`[Auth] ${parsedError.reason} for ${account.email}, flagging pool sandbox for family ${getFamilyName(request.model, account)}.`);
              flagAccountChallenge(account.email, "sandbox", getFamilyName(request.model, account), {
                type: "CAPTCHA",
                url: parsedError.validationUrl || "https://cloud.google.com/gemini/docs/codeassist/request-license",
                reason: parsedError.reason,
                message: parsedError.message,
              });
              if (isPost429Probe) {
                releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
                isPost429Probe = false;
                break;
              }
              deleteSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model);
              excludedEmails.add(account.email);
              continue;
            }
            if (parsedError.isModelUnsupported) {
              console.log(`[Model] Unsupported model ${request.model} for ${account.email}, marking capability.`);
              flagModelUnsupported(account.email, request.model);
              await updateAccountUsage(account.email, false, request.model, "sandbox", status);
              if (isPost429Probe) {
                releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
                isPost429Probe = false;
                break;
              }
              deleteSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model);
              excludedEmails.add(account.email);
              continue;
            }
            await updateAccountUsage(account.email, false, request.model, "sandbox", status);
            if (isPost429Probe) {
              releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
              isPost429Probe = false;
            }
            return jsonError(status, {
              error: { message: `Access denied: ${parsedError.reason}`, type: "access_denied", code: status.toString() },
            }, localAttempts);
          }

          if (
            status === 400
            && (errText.toLowerCase().includes("tool schema")
              || errText.includes("Invalid JSON payload")
              || errText.toLowerCase().includes("function_declarations"))
            && !aggressive
          ) {
            console.log(`[Schema] Detected tool schema error for ${account.email}, retrying with aggressive cleaning on same account...`);
            aggressive = true;
            localAttempts--;
            totalLogicalAttempts--;
            currentAccountAttempts--;
            continue;
          }

          if (status === 400) {
            const invalidToolIndex = errText.match(/tools\.(\d+)\.(?:custom\.)?input_schema/);
            if (invalidToolIndex) {
              const index = Number(invalidToolIndex[1]);
              const tool = request.tools?.[index];
              const declaration = googleBody.request.tools?.flatMap((group: any) => group.functionDeclarations || [])?.[index];
              console.warn(`[InvalidToolSchema] Request: ${requestId} | Index: ${index} | Name: ${JSON.stringify(tool?.name ?? declaration?.name ?? "unknown")}`
                + ` | OriginalRootKeys: ${JSON.stringify(Object.keys(tool?.parameters || {}))}`
                + ` | UpstreamRootKeys: ${JSON.stringify(Object.keys(declaration?.parametersJsonSchema ?? declaration?.parameters ?? {}))}`);
            }
            if (isPost429Probe) {
              releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
              isPost429Probe = false;
            } else {
              upsertSessionRoutingGuard({
                sessionScopeKey,
                digestScopeKey,
                model: request.model,
                accountEmail: account.email,
                status: "pinned",
                requestDigest: payloadDigest,
                attemptsUsed: 0,
                accountAttemptsUsed: 0,
                accountsTouched: [account.email],
                budgetExhaustedUntil: null,
              });
            }
            console.warn(`[InvalidRequest] Request: ${requestId} | Model: ${googleBody.model} | Contents: ${googleBody.request.contents.length} | Tools: ${request.tools?.length || 0} | Bytes: ${Buffer.byteLength(JSON.stringify(googleBody))}`);
            return jsonError(400, {
              error: {
                message: parsedError.message || "Upstream rejected the request as invalid.",
                type: "invalid_request_error",
                code: parsedError.reason,
                attempts: attemptLogs,
              },
            }, localAttempts);
          }
          aggressive = false;

          // 429 Handling: Evaluate fresh quota evidence before deciding whether to protect or fail over.
          if (status === 429) {
            let resetSeconds = parsedError.resetSeconds || 0;
            try {
              const errJson = JSON.parse(errText);
              const details = errJson.error?.details || [];
              for (const detail of details) {
                if (detail.metadata?.quotaResetDelay) resetSeconds = parseFloat(detail.metadata.quotaResetDelay);
                if (detail.retryDelay) resetSeconds = parseFloat(detail.retryDelay);
              }
              if (resetSeconds === 0 && errJson.error?.message?.includes("reset after")) {
                const match = errJson.error.message.match(/reset after\s+([0-9.]+)s/);
                if (match) resetSeconds = parseFloat(match[1]);
              }
            } catch {}

            let quotaState = evaluateAccountModelQuotaState(
              account,
              googleBody.model,
              request.reasoningEffort,
              Date.now(),
            );

            // Trigger single-flight on-demand refresh when quota/window data is missing, >60s stale,
            // or when upstream explicitly claims QUOTA_EXHAUSTED while fresh cache still says >5% available.
            if (
              quotaState.needsRefresh
              || (parsedError.isExplicitQuotaExhausted && quotaState.obviouslySufficient)
            ) {
              await refreshAccountQuotaSingleFlight(account);
              quotaState = evaluateAccountModelQuotaState(
                account,
                googleBody.model,
                request.reasoningEffort,
                Date.now(),
              );
            }

            // Only allow rotating to another account B when:
            // 1. Upstream explicitly reported quota exhaustion (QUOTA_EXHAUSTED / explicit quota reached)
            // 2. Fresh quota or quotaWindow data for this model confirms remainingFraction <= 0
            if (parsedError.isExplicitQuotaExhausted && quotaState.confirmedExhausted) {
              if (isPost429Probe) {
                releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
                isPost429Probe = false;
              }
              deleteSessionRoutingGuard(sessionScopeKey, digestScopeKey, request.model);
              await updateAccountUsage(account.email, false, request.model, "sandbox", 429);
              const effectiveResetSecs = resetSeconds || quotaState.earliestResetSeconds;
              const cooldownDuration = effectiveResetSecs ? `${Math.ceil(effectiveResetSecs)}s` : undefined;
              markCooldown(account.email, "sandbox", getFamilyName(request.model, account), cooldownDuration);
              excludedEmails.add(account.email);
              currentAccountEmail = undefined;
              currentAccountAttempts = 0;
              continue;
            }

            // Otherwise: protect account A, do NOT touch B, do NOT deduct healthScore, do NOT zero quota.
            const retryAfterSeconds = Math.max(
              MIN_429_PROTECTION_RETRY_SECONDS,
              Math.ceil(resetSeconds || 0),
            );
            const retryAt = Date.now() + retryAfterSeconds * 1000;
            const isEvidenceConflict = parsedError.isExplicitQuotaExhausted && quotaState.obviouslySufficient;
            const protectionReason = isEvidenceConflict
              ? "quota_evidence_conflict"
              : quotaState.obviouslySufficient
                ? "upstream_429_with_quota"
                : "rate_limit_exceeded";
            const errorCode =
              protectionReason === "upstream_429_with_quota" || protectionReason === "quota_evidence_conflict"
                ? "upstream_429_with_quota"
                : "rate_limit_exceeded";
            const errorMessage =
              errorCode === "upstream_429_with_quota"
                ? `Upstream returned 429 for model '${request.model}' while account '${account.email}' still has sufficient quota. Rotation stopped; retry after ${retryAfterSeconds}s.`
                : `Account '${account.email}' for model '${request.model}' returned 429 without confirmed quota exhaustion. Rotation stopped; retry after ${retryAfterSeconds}s.`;

            const protectedGuard = upsertSessionRoutingGuard({
              sessionScopeKey,
              digestScopeKey,
              model: request.model,
              accountEmail: account.email,
              status: "protected_429",
              reason: protectionReason,
              errorCode,
              errorStatus: 429,
              errorMessage,
              retryAt,
              probeInProgress: false,
              requestDigest: payloadDigest,
              attemptsUsed: totalLogicalAttempts,
              accountAttemptsUsed: currentAccountAttempts,
              accountsTouched,
            });
            isPost429Probe = false;
            return buildProtected429Error(request.model, protectedGuard, localAttempts, attemptLogs);
          }

          if (status < 500) {
            await updateAccountUsage(account.email, false, request.model, "sandbox", status);
            if (isPost429Probe) {
              releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
              isPost429Probe = false;
            }
            return jsonError(status, {
              error: {
                message: parsedError.message || `Upstream rejected the request (HTTP ${status}).`,
                type: "invalid_request_error",
                code: parsedError.reason,
                attempts: attemptLogs,
              },
            }, localAttempts);
          }

          await updateAccountUsage(account.email, false, request.model, "sandbox", status);
          if (handleOrdinaryFailureOnCurrentAccount(status, parsedError.reason, parsedError.message)) {
            continue;
          }
          break;
        }

        if (!googleRes.body) {
          clearTimers();
          if (isPost429Probe) {
            releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
            isPost429Probe = false;
          }
          if (request.stream) {
            return jsonError(502, { error: { message: "No response body from upstream" } }, localAttempts);
          }
          throw new Error("No response body");
        }

        await clearAccountPoolSuspension(account.email, googleBody.model);

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
              modelFamily: getFamilyName(request.model, account),
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

          upsertSessionRoutingGuard({
            sessionScopeKey,
            digestScopeKey,
            model: request.model,
            accountEmail: account.email,
            status: "pinned",
            reason: null,
            errorCode: null,
            errorStatus: null,
            errorMessage: null,
            retryAt: null,
            probeInProgress: false,
            requestDigest: payloadDigest,
            attemptsUsed: 0,
            accountAttemptsUsed: 0,
            accountsTouched: [account.email],
            budgetExhaustedUntil: null,
          });
          isPost429Probe = false;

          recordSessionBinding({
            identity: sessionIdentity,
            accountEmail: account.email,
            model: request.model,
            modelFamily: getFamilyName(request.model, account),
            pool: "sandbox",
            projectId: effectiveProjectId,
            endpoint: googleUrl,
          });
          await updateAccountUsage(account.email, true, request.model, "sandbox");
          return { kind: "stream", stream, attempts: localAttempts };
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
          console.warn(`[Empty] Account ${account.email} returned empty response for ${request.model}...`);
          attemptLogs.push({ email: account.email, status: 502, reason: "empty_response" });
          if (handleOrdinaryFailureOnCurrentAccount(502, "empty_response")) {
            continue;
          }
          break;
        }

        upsertSessionRoutingGuard({
          sessionScopeKey,
          digestScopeKey,
          model: request.model,
          accountEmail: account.email,
          status: "pinned",
          reason: null,
          errorCode: null,
          errorStatus: null,
          errorMessage: null,
          retryAt: null,
          probeInProgress: false,
          requestDigest: payloadDigest,
          attemptsUsed: 0,
          accountAttemptsUsed: 0,
          accountsTouched: [account.email],
          budgetExhaustedUntil: null,
        });
        isPost429Probe = false;

        recordSessionBinding({
          identity: sessionIdentity,
          accountEmail: account.email,
          model: request.model,
          modelFamily: getFamilyName(request.model, account),
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
            modelFamily: getFamilyName(request.model, account),
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
        return { kind: "result", result, attempts: localAttempts };
      } catch (error: any) {
        clearTimers();
        if (signal?.aborted) {
          if (isPost429Probe) {
            releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
            isPost429Probe = false;
          }
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
        if (handleOrdinaryFailureOnCurrentAccount(500, error.message, `Proxy exception: ${error.message}`)) {
          continue;
        }
        return jsonError(500, { error: { message: `Proxy exception: ${error.message}` } }, localAttempts);
      }
    }
  } finally {
    if (isPost429Probe) {
      releaseSessionRoutingGuardProbe(sessionScopeKey, digestScopeKey, request.model);
    }
  }

  return buildCompletionFailure(request.model, "sandbox", localAttempts, attemptLogs, request.reasoningEffort);
}
