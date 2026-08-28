const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_USER_AGENT = "codex-tui/0.118.0 (antigravity-proxy)";

type FetchImpl = typeof fetch;

export function normalizeResponsesBody(body: any): any {
  const {
    previous_response_id,
    stream_options,
    prompt_cache_retention,
    safety_identifier,
    max_output_tokens,
    max_completion_tokens,
    temperature,
    top_p,
    truncation,
    context_management,
    user,
    ...cleanBody
  } = body || {};
  cleanBody.stream = true;
  return cleanBody;
}

export function normalizeCompactBody(body: any): any {
  const {
    previous_response_id,
    stream,
    stream_options,
    prompt_cache_retention,
    prompt_cache_options,
    safety_identifier,
    max_output_tokens,
    max_completion_tokens,
    temperature,
    top_p,
    truncation,
    context_management,
    user,
    ...cleanBody
  } = body || {};
  if (cleanBody.instructions == null) cleanBody.instructions = "";
  if (cleanBody.parallel_tool_calls == null) cleanBody.parallel_tool_calls = false;
  return cleanBody;
}

interface CodexCallOptions {
  accessToken: string;
  accountId?: string;
  sessionId: string;
  body: any;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}

async function callCodex(operation: "responses" | "compact", options: CodexCallOptions): Promise<Response> {
  const isResponses = operation === "responses";
  const cleanBody = isResponses ? normalizeResponsesBody(options.body) : normalizeCompactBody(options.body);
  if (typeof cleanBody.prompt_cache_key !== "string" || cleanBody.prompt_cache_key.length === 0) {
    cleanBody.prompt_cache_key = options.sessionId;
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.accessToken}`,
    "User-Agent": CODEX_USER_AGENT,
    Accept: isResponses ? "text/event-stream" : "application/json",
    Connection: "Keep-Alive",
    Originator: "codex-tui",
    Session_id: options.sessionId,
  });
  if (options.accountId) headers.set("Chatgpt-Account-Id", options.accountId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  try {
    return await (options.fetchImpl || fetch)(
      `${(options.baseUrl || CODEX_BASE_URL).replace(/\/+$/, "")}${isResponses ? "/responses" : "/responses/compact"}`,
      { method: "POST", headers, body: JSON.stringify(cleanBody), signal: controller.signal },
    );
  } finally {
    clearTimeout(timer);
  }
}

export function callCodexResponsesAPI(options: CodexCallOptions): Promise<Response> {
  return callCodex("responses", options);
}

export function callCodexCompactAPI(options: CodexCallOptions): Promise<Response> {
  return callCodex("compact", options);
}
