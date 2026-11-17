export interface GoogleApiError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      "@type"?: string;
      reason?: string;
      domain?: string;
      metadata?: Record<string, string>;
      errorInfo?: {
        reason: string;
        metadata?: Record<string, string>;
      };
      validation_url?: string;
      retryDelay?: string;
      retry_delay?: string;
    }>;
  };
}

export interface ParsedGoogleError {
  reason: string;
  validationUrl?: string;
  isQuotaExhausted: boolean;
  isExplicitQuotaExhausted: boolean;
  isRateLimited: boolean;
  isAmbiguous429: boolean;
  isChallengeRequired: boolean;
  isModelUnsupported: boolean;
  isServiceSuspended: boolean;
  isTosViolation: boolean;
  appealUrl?: string;
  status: number;
  message?: string;
  resetSeconds?: number;
}

const GENERIC_RESOURCE_EXHAUSTED_MESSAGE = /^resource has been exhausted(?:\s*\(e\.g\.\s*check quota\.?\))?\.?$/i;
const EXPLICIT_QUOTA_MESSAGE =
  /\b(?:individual\s+quota\s+reached|quota\s+exhausted|quota\s+exceeded|exceeded\s+your\s+current\s+quota|daily\s+quota|weekly\s+quota|window\s+quota\s+exhausted|model\s+quota\s+exhausted)\b/i;
const RATE_LIMIT_MESSAGE =
  /\b(?:rate\s+limit(?:\s+exceeded)?|too\s+many\s+requests|requests\s+per\s+(?:minute|second)|rpm\b|tpm\b|automated\s+queries)\b/i;

export function parseGoogleError(body: string): ParsedGoogleError {
  let reason = "unknown_error";
  let validationUrl: string | undefined;
  let isQuotaExhausted = false;
  let isExplicitQuotaExhausted = false;
  let isRateLimited = false;
  let isAmbiguous429 = false;
  let isChallengeRequired = false;
  let isModelUnsupported = false;
  let isServiceSuspended = false;
  let isTosViolation = false;
  let appealUrl: string | undefined;
  let status = 500;
  let message: string | undefined;
  let resetSeconds: number | undefined;

  try {
    const json: GoogleApiError = JSON.parse(body);
    const err = json.error;

    if (err) {
      message = err.message;
      if (typeof err.code === "number" && err.code >= 400 && err.code < 600) {
        status = err.code;
      }

      if (err.status === "INVALID_ARGUMENT") {
        reason = "invalid_argument";
        status = 400;
      }

      const trimmedMessage = (err.message || "").trim();
      const isGenericResourceExhaustedMsg = GENERIC_RESOURCE_EXHAUSTED_MESSAGE.test(trimmedMessage);

      if (err.status === "RESOURCE_EXHAUSTED" || err.code === 429) {
        status = 429;
        if (!isGenericResourceExhaustedMsg && EXPLICIT_QUOTA_MESSAGE.test(trimmedMessage)) {
          isQuotaExhausted = true;
          isExplicitQuotaExhausted = true;
          reason = "quota_exhausted";
        } else if (RATE_LIMIT_MESSAGE.test(trimmedMessage)) {
          isRateLimited = true;
          reason = "rate_limit_exceeded";
        } else {
          isAmbiguous429 = true;
          reason = "resource_exhausted";
        }
      } else if (!isGenericResourceExhaustedMsg && EXPLICIT_QUOTA_MESSAGE.test(trimmedMessage)) {
        isQuotaExhausted = true;
        isExplicitQuotaExhausted = true;
        reason = "quota_exhausted";
        status = 429;
      } else if (RATE_LIMIT_MESSAGE.test(trimmedMessage)) {
        isRateLimited = true;
        reason = "rate_limit_exceeded";
        status = 429;
      }

      if (err.message?.includes("VALIDATION_REQUIRED")) {
        isChallengeRequired = true;
        reason = "validation_required";
        status = 403;
      }

      if (err.message?.includes("Gemini Code Assist license") || err.message?.includes("SUBSCRIPTION_REQUIRED")) {
        isChallengeRequired = true;
        reason = "subscription_required";
        status = 403;
      }

      if (err.status === "NOT_FOUND" || err.message?.includes("not found") || err.message?.includes("not supported")) {
        isModelUnsupported = true;
        reason = "model_not_found";
        status = 404;
      }

      if (err.details) {
        for (const detail of err.details) {
          const detailReason = detail.reason || detail.errorInfo?.reason;

          if (detailReason === "VALIDATION_REQUIRED") {
            isChallengeRequired = true;
            reason = "validation_required";
            status = 403;
            if (detail.validation_url) validationUrl = detail.validation_url;
            if (detail.metadata?.validation_url) validationUrl = detail.metadata.validation_url;
            if (detail.errorInfo?.metadata?.validation_url) validationUrl = detail.errorInfo.metadata.validation_url;
          }

          if (detailReason === "QUOTA_EXHAUSTED") {
            isQuotaExhausted = true;
            isExplicitQuotaExhausted = true;
            isRateLimited = false;
            isAmbiguous429 = false;
            reason = "quota_exhausted";
            status = 429;
          } else if (detailReason === "RATE_LIMIT_EXCEEDED" && !isExplicitQuotaExhausted) {
            isRateLimited = true;
            isAmbiguous429 = false;
            reason = "rate_limit_exceeded";
            status = 429;
          }

          const rawDelay =
            detail.retryDelay
            || detail.retry_delay
            || detail.metadata?.quotaResetDelay
            || detail.errorInfo?.metadata?.quotaResetDelay;
          if (rawDelay) {
            const parsed = parseFloat(rawDelay);
            if (!isNaN(parsed) && parsed > 0) resetSeconds = parsed;
          }
        }
      }

      if (!resetSeconds && err.message) {
        const match =
          err.message.match(/retry\s+in\s+([0-9.]+)\s*s/i)
          || err.message.match(/retry\s+after\s+([0-9.]+)\s*s/i)
          || err.message.match(/reset\s+after\s+([0-9.]+)\s*s/i);
        if (match) {
          const parsed = parseFloat(match[1]!);
          if (!isNaN(parsed) && parsed > 0) resetSeconds = parsed;
        }
      }

      // A service suspension must take precedence over
      // incidental words such as "quota" or "not supported" in the message.
      const suspension = err.details?.find(detail =>
        detail.reason === "TOS_VIOLATION" || detail.errorInfo?.reason === "TOS_VIOLATION");
      if (suspension || /service has been disabled.*violation of terms of service/i.test(err.message || "")) {
        reason = "tos_violation";
        status = 403;
        isServiceSuspended = true;
        isTosViolation = true;
        isChallengeRequired = false;
        isQuotaExhausted = false;
        isExplicitQuotaExhausted = false;
        isRateLimited = false;
        isAmbiguous429 = false;
        isModelUnsupported = false;
        const url = suspension?.metadata?.appeal_url || suspension?.errorInfo?.metadata?.appeal_url;
        if (url && /^https:\/\//i.test(url)) appealUrl = url;
      }
    }
  } catch {
    if (body.includes("automated queries")) {
      isRateLimited = true;
      reason = "rate_limit_exceeded";
      status = 429;
    }
  }

  return {
    reason,
    validationUrl,
    isQuotaExhausted,
    isExplicitQuotaExhausted,
    isRateLimited,
    isAmbiguous429,
    isChallengeRequired,
    isModelUnsupported,
    isServiceSuspended,
    isTosViolation,
    appealUrl,
    status,
    message,
    resetSeconds,
  };
}
