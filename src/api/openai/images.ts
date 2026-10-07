import { randomInt } from "node:crypto";
import { emitAccountFlash, getAccounts, prepareAccountForRequest, updateAccountUsage } from "../../auth/manager";
import type { AntigravityAccount } from "../../auth/types";
import { getProxyConfig } from "../../config/manager";
import { generateFingerprint, getImpersonationHeaders } from "../../utils/headers";

const IMAGE_SIZES = new Set(["512", "1K", "2K", "4K"]);
const ASPECT_RATIOS = new Set(["1:1", "1:4", "4:1", "1:8", "8:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]);
const SQUARE_SIZES: Record<string, string> = { "512x512": "512", "1024x1024": "1K", "2048x2048": "2K", "4096x4096": "4K" };

export interface ImageGenerationRuntime {
  getAccounts(): AntigravityAccount[];
  prepareAccount(email: string, forceRefresh?: boolean): Promise<AntigravityAccount | null>;
  getEndpoints(): string[];
  getTimeoutMs(): number;
  randomIndex(length: number): number;
  fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response>;
  onSuccess(account: AntigravityAccount, model: string): Promise<void>;
}

const defaultRuntime: ImageGenerationRuntime = {
  getAccounts,
  prepareAccount: prepareAccountForRequest,
  getEndpoints: () => getProxyConfig().endpoints.sandbox,
  getTimeoutMs: () => getProxyConfig().models.timeouts.image || getProxyConfig().models.timeouts.stream || 900_000,
  randomIndex: randomInt,
  fetch: (...args) => fetch(...args),
  async onSuccess(account, model) {
    await updateAccountUsage(account.email, true, model, "image");
    emitAccountFlash(account.email);
  },
};

function json(body: unknown, status = 200, attempts = 0) {
  return Response.json(body, { status, headers: {
    "Access-Control-Allow-Origin": "*",
    "X-Antigravity-Attempts": String(attempts),
  } });
}

function error(message: string, status: number, code: string, attempts = 0, param?: string) {
  return json({ error: { message, type: status >= 500 ? "api_error" : "invalid_request_error", code, ...(param ? { param } : {}) } }, status, attempts);
}

export function imageGenerationEndpoints(endpoints: string[]): string[] {
  return [...new Set(endpoints.map(endpoint => {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/:(?:streamGenerateContent|generateContent)$/, ":generateContent");
    url.searchParams.delete("alt");
    return url.toString();
  }))];
}

/** Each request selects one random Google account; endpoint fallback stays on it. */
export async function handleImageGeneration(req: Request, runtime: ImageGenerationRuntime = defaultRuntime): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return error("Invalid JSON in request body", 400, "invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return error("Request body must be an object", 400, "invalid_request");
  for (const field of ["model", "prompt"]) {
    if (typeof body[field] !== "string" || !body[field].trim()) return error(`${field} must be a non-empty string`, 400, "invalid_request", 0, field);
  }
  if (body.n !== undefined && body.n !== 1) return error("Only n=1 is supported", 400, "invalid_request", 0, "n");
  if (body.response_format !== undefined && body.response_format !== "b64_json") return error("Only response_format=b64_json is supported", 400, "invalid_request", 0, "response_format");
  if (body.stream !== undefined && body.stream !== false) return error("Image generation does not support streaming", 400, "invalid_request", 0, "stream");

  const squareSize = typeof body.size === "string" ? SQUARE_SIZES[body.size] : undefined;
  const sizeAlias = squareSize || body.size;
  if (body.image_size !== undefined && sizeAlias !== undefined && body.image_size !== sizeAlias) return error("image_size and size disagree", 400, "invalid_request", 0, "size");
  const imageSize = body.image_size ?? sizeAlias ?? "1K";
  if (!IMAGE_SIZES.has(imageSize)) return error("image_size/size must be 512, 1K, 2K, or 4K (size also accepts square pixel dimensions)", 400, "invalid_request", 0, "image_size");
  const aspectRatio = body.aspect_ratio ?? "1:1";
  if (!ASPECT_RATIOS.has(aspectRatio)) return error("Unsupported aspect_ratio", 400, "invalid_request", 0, "aspect_ratio");
  if (squareSize && aspectRatio !== "1:1") return error("Square pixel size requires aspect_ratio=1:1; use image_size for other ratios", 400, "invalid_request", 0, "aspect_ratio");
  if (body.thinking_level !== undefined && !["minimal", "low", "medium", "high"].includes(body.thinking_level)) return error("thinking_level must be minimal, low, medium, or high", 400, "invalid_request", 0, "thinking_level");

  let attempts = 0;
  let account: AntigravityAccount | null = null;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(runtime.getTimeoutMs())]);
  try {
    signal.throwIfAborted();
    const candidates = runtime.getAccounts().filter(a => a.refreshToken && !a.challenge);
    while (candidates.length) {
      signal.throwIfAborted();
      const selected = candidates.splice(runtime.randomIndex(candidates.length), 1)[0]!;
      const ready = await runtime.prepareAccount(selected.email);
      if (ready?.accessToken && ready.projectId) { account = ready; break; }
    }
    if (!account) return error("No ready Google OAuth accounts with a project ID", 503, "no_accounts");
    account.fingerprint ||= generateFingerprint(account.email);
    const endpoints = imageGenerationEndpoints(runtime.getEndpoints());
    if (!endpoints.length) return error("No Antigravity endpoints configured", 503, "no_endpoints");
    const requestId = `img-${crypto.randomUUID()}`;
    const upstreamBody = {
      project: account.projectId,
      // Arbitrary upstream IDs are passed verbatim, with no chat-model aliasing.
      model: body.model,
      userAgent: "antigravity",
      requestType: "image_gen",
      requestId,
      request: {
        contents: [{ role: "user", parts: [{ text: body.prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio, imageSize },
          ...(body.thinking_level ? { thinkingConfig: { thinkingLevel: body.thinking_level, includeThoughts: false } } : {}),
        },
      },
    };
    console.log(`[Images] ${requestId} | Model: ${body.model} | Account: ${account.email} | Size: ${imageSize} | Ratio: ${aspectRatio}`);
    let refreshed = false;
    let lastError = error("Image generation failed", 502, "upstream_error");
    for (let index = 0; index < endpoints.length; index++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        attempts++;
        response = await runtime.fetch(endpoints[index]!, {
          method: "POST",
          headers: getImpersonationHeaders(account.accessToken!, account.fingerprint, body.model),
          body: JSON.stringify(upstreamBody),
          signal,
        });
      } catch (failure) {
        if (signal.aborted) throw failure;
        lastError = error("Unable to reach Antigravity upstream", 502, "upstream_unavailable", attempts);
        continue;
      }
      const text = await response.text();
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        const ready = await runtime.prepareAccount(account.email, true);
        if (!ready?.accessToken || !ready.projectId) return error("Google OAuth refresh failed", 401, "oauth_refresh_failed", attempts);
        account = ready;
        upstreamBody.project = ready.projectId;
        index--;
        continue;
      }
      let data: any;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!response.ok) {
        let message = typeof data?.error?.message === "string" ? data.error.message : `Antigravity returned HTTP ${response.status}`;
        for (const secret of [account.accessToken, account.refreshToken]) if (secret) message = message.replaceAll(secret, "[REDACTED]");
        lastError = error(message.slice(0, 1600), response.status, typeof data?.error?.status === "string" ? data.error.status : "upstream_error", attempts);
        // A successful generation is never retried. Retry only endpoint failures,
        // retaining the same random account for the entire incoming request.
        if (![404, 429, 500, 502, 503, 504].includes(response.status)) return lastError;
        continue;
      }
      if (!data) return error("Antigravity returned invalid JSON", 502, "invalid_upstream_response", attempts);
      const result = data.response || data;
      const images: Array<{ b64_json: string; mime_type: string }> = [];
      for (const candidate of result.candidates || []) {
        for (const part of candidate.content?.parts || []) {
          const inline = part.inlineData || part.inline_data;
          const mime = inline?.mimeType || inline?.mime_type;
          if (!part.thought && typeof mime === "string" && mime.startsWith("image/") && typeof inline?.data === "string" && inline.data.length) {
            images.push({ b64_json: inline.data, mime_type: mime });
          }
        }
      }
      if (!images.length) return error("Antigravity returned no generated image", 502, "no_image", attempts);
      try { await runtime.onSuccess(account, body.model); } catch { console.warn("[Images] Could not persist account usage"); }
      return json({ created: Math.floor(Date.now() / 1000), model: body.model, ...(result.modelVersion ? { model_version: result.modelVersion } : {}), data: images.slice(0, 1) }, 200, attempts);
    }
    return lastError;
  } catch {
    if (req.signal.aborted) return error("Request was aborted by the client", 499, "request_aborted", attempts);
    if (signal.aborted) return error("Image generation timed out", 504, "timeout", attempts);
    return error("Image generation failed", 502, "upstream_error", attempts);
  }
}
