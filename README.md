# Antigravity Proxy

![Antigravity Proxy Dashboard](screenshots/screenshot.png)

Antigravity Proxy is a high-performance gateway that exposes Google's internal Gemini, Claude, and GPT-OSS APIs through an **OpenAI-compatible interface**. It enables seamless integration between advanced models and CLI agents (such as **OpenCode** or **Claude Code**), as well as any application supporting the OpenAI API standard.

This project is strongly inspired by [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth).

## Features

- **OpenAI API Compatibility**: Full support for `v1/chat/completions` with streaming (SSE).
- **Structured JSON Outputs**: Supports OpenAI-compatible `json_object` and `json_schema` response formats for Gemini and Claude models.
- **Multi-Agent Support**: Specifically designed to work with **Claude Code**, **OpenCode**, and other agentic frameworks.
- **Account Rotation & Health Scoring**: Automatically rotates multiple Google accounts, penalizing those with errors and favoring healthy ones.
- **Quota Management**: Real-time monitoring and automatic cooldowns (backoff) on `429 Too Many Requests` errors.
- **Dual-Pool Routing**:
  - **CLI Pool**: Routes to production Gemini endpoints.
  - **Sandbox Pool**: Accesses Antigravity Gemini, Claude Thinking, and GPT-OSS models.
- **Integrated Dashboard**: Manage accounts, monitor health, and view real-time logs via a built-in web interface.
- **Persistent Session Affinity**: Recognizes OpenCode, Codex, and OpenAI cache identifiers and keeps each session/model bound to its successful account, pool, and endpoint in SQLite.
- **Automatic Project Discovery**: Auto-detects Google Cloud Project IDs via Cloud SDK impersonation.

## Local Deployment

Requirements: Bun 1.0 or later.

```bash
git clone https://github.com/maomaozi/antigravity-proxy.git
cd antigravity-proxy
bun install
bun run start
```

The server listens on port `3000` by default. Set the `PORT` environment
variable to use another port:

```bash
PORT=3001 bun run start
```

## API Usage

The proxy supports OpenAI Chat Completions (`/v1/chat/completions`) and
Responses (`/v1/responses`) request/stream formats. Codex OAuth accounts can
also use native Responses forwarding and context compaction
(`/v1/responses/compact`). If the server is running on a different port,
replace `3000` in the examples below.

### Basic Chat Completion

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "antigravity-gemini-3.7-flash",
    "messages": [
      {"role": "user", "content": "Explain what a reverse proxy is."}
    ]
  }'
```

Set `"stream": true` to receive an OpenAI-compatible SSE stream.

### Responses API

The Responses endpoint uses the same account routing, session affinity, retry,
Gemini tool-call protocol handling, structured output, and usage persistence as
Chat Completions:

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "antigravity-gemini-3.7-flash",
    "input": "Explain what a reverse proxy is."
  }'
```

Set `"stream": true` for Responses SSE events such as
`response.created`, `response.output_text.delta`,
`response.function_call_arguments.delta`, and the terminal
`response.completed` / `response.incomplete` event. The endpoint supports the
Responses equivalents of the existing Chat features: full-history text and
data-URL image input, system `instructions`, reasoning effort, function tools,
Codex-style `namespace` tool groups, freeform `custom` tools, tool outputs,
parallel tool calls, `text.format` JSON modes, `max_output_tokens`,
`temperature`, `top_p`, `prompt_cache_key`, and metadata.

`web_search` is accepted and maps to Gemini native Google Search when it is the
only tool capability. Antigravity's current v1internal endpoint rejects native
Google Search mixed with client function calling, so mixed Codex requests keep
the function/namespace/custom tools and omit native search instead of failing
the whole request. Legacy `local_shell` declarations are accepted for client
compatibility but are not exposed as a synthetic Gemini function.

Conversation history is currently stateless: resend the complete ordered
`response.output` items with the next request. Server-managed Responses features
that do not have an equivalent in the current implementation are rejected
explicitly, including `previous_response_id`, `conversation`, `store: true`,
background responses, file-ID input, and remote image URLs.

### Codex OAuth and Native Responses

Codex is kept on a separate upstream protocol path: it does **not** pass through
the Antigravity/Google request or response translators. Route a model to Codex
in either of these explicit ways:

- Use `codex/<upstream-model>` in a request, for example `codex/gpt-5-codex`.
- Add the raw upstream model ID to `codex.models` in `config.json` (or through
  the dashboard configuration dialog).

This explicit routing avoids collisions with Antigravity models whose names
also contain `gpt`.

Add Codex OAuth accounts from the dashboard with **Add Codex Account**. The
proxy requests an OpenAI device code, displays the verification URL and
one-time code, and performs polling/token exchange on the server. The browser
never receives the device auth ID, access token, refresh token, or ID token.
Codex credentials are stored separately in `data/codex-accounts.json` by
default; set `CODEX_ACCOUNTS_FILE` to use another path.

For native Codex Responses:

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "codex/gpt-5-codex",
    "input": "Summarize this repository.",
    "stream": true
  }'
```

Streaming Responses bytes are forwarded without re-serializing them. A side
observer reads final usage metadata for the existing Usage/Sessions statistics.
When `stream` is false, the native upstream SSE is aggregated into canonical
Responses JSON without translating output item types.

Codex context compaction is exposed as a peer endpoint:

```bash
curl http://127.0.0.1:3000/v1/responses/compact \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "codex/gpt-5-codex",
    "input": []
  }'
```

Compact is non-streaming. Its input, cached input, visible output, reasoning,
total tokens, account, model, and `/v1/responses/compact` endpoint are recorded
in the same per-request usage store and under the same session affinity as
ordinary `/v1/responses` calls. Codex `output_tokens` includes reasoning tokens;
the proxy normalizes that only for internal statistics so visible output and
reasoning keep the dashboard's existing non-overlapping meanings. The upstream
API response itself is not changed.

The default Codex configuration is equivalent to:

```json
{
  "codex": {
    "enabled": true,
    "models": [],
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "responsesTimeoutMs": 120000,
    "compactTimeoutMs": 60000,
    "maxAttempts": 3
  }
}
```

### Session Affinity

The proxy automatically recognizes `x-session-affinity`, `x-opencode-session`,
`x-session-id`, Codex `session-id`/`thread-id`, Codex turn metadata, and the
OpenAI `prompt_cache_key` request field. Successful routes are persisted per
session and model in `data/session-bindings.sqlite`. The dashboard's
**Sessions** page shows the current session, account, model, pool, and endpoint
bindings.

Use `SESSION_DB_FILE` to place the SQLite database elsewhere and
`SESSION_BINDING_RETENTION_DAYS` to change the default 30-day retention. Cookie
session lookup is disabled by default; `SESSION_COOKIE_NAMES` may contain a
comma-separated allowlist when a deployment has a conversation-specific
cookie.

Each successful upstream request also stores its final token metadata in the
same SQLite database. Open **Usage** in the dashboard to filter records by
session, model, time range, request ID, or account. Input, cached input,
uncached input, visible output, separately reported reasoning, and total tokens
are retained. If the upstream response does not report cached input metadata,
cached and uncached input are treated as unknown (`null`) rather than zero; the
dashboard shows `—` / **Not reported** for those records. Aggregate cached and
uncached totals include the records that did report cache metadata, and the
dashboard shows the reporting coverage when it is partial. Set
`REQUEST_USAGE_RETENTION_DAYS` to override the default usage
retention period, which otherwise follows `SESSION_BINDING_RETENTION_DAYS`.

Session affinity is always preferred. For the same session and model, the proxy
reuses the previously successful account whenever it is available. When a bound account is cooling down, the proxy can wait briefly for it before
failing over, which helps preserve upstream prompt-cache affinity. Configure the
maximum wait with `scheduling.maxCacheFirstWaitSeconds` in `config.json`.

### JSON Object Output

Use `json_object` when the response must be a valid JSON object but does not
need to follow a predefined schema:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "antigravity-gemini-3.7-flash",
    "messages": [
      {"role": "user", "content": "Return a user object with name Alice and age 30."}
    ],
    "response_format": {
      "type": "json_object"
    }
  }'
```

The returned `choices[0].message.content` is a JSON string, for example:

```json
{"name":"Alice","age":30}
```

### Strict JSON Schema Output

Use `json_schema` when the output must conform to a specific structure:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "antigravity-gemini-3.7-flash",
    "messages": [
      {"role": "user", "content": "Return the current processing status."}
    ],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "processing_status",
        "strict": true,
        "schema": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "status": {"type": "string", "enum": ["ok"]},
            "count": {"type": "integer"}
          },
          "required": ["status", "count"]
        }
      }
    }
  }'
```

Structured JSON output is supported for Gemini and Claude models. Claude
thinking is disabled for `json_schema` requests because the upstream API cannot
combine thinking with schema-forced tool use. GPT-OSS currently does not support
these response-format constraints through the upstream API.

## Integration Guides

### Claude Code Configuration
To use **Claude Code** with Antigravity Proxy, point the API base URL to your local instance and specify a model from the Sandbox Pool:

```bash
# Point Claude Code to the proxy
export CLAUDE_CODE_API_BASE="http://localhost:3000/v1"

# Run Claude specifying an Antigravity model
claude --model antigravity-claude-sonnet-4-6-thinking
```

### OpenCode Configuration
Add the following provider to your `~/.config/opencode/opencode.json` under the `"provider"` key:

```json
"provider": {
    "antigravity-proxy": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Antigravity Proxy",
        "options": {
            "baseURL": "http://localhost:3000/v1"
        },
        "models": {
            "antigravity-gemini-3.7-flash": {
                "name": "Gemini 3.7 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65536 },
                "reasoning": true,
                "variants": {
                    "low": { "reasoningEffort": "low" },
                    "medium": { "reasoningEffort": "medium" },
                    "high": { "reasoningEffort": "high" }
                }
            },
            "antigravity-gemini-3.6-flash": {
                "name": "Gemini 3.6 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65536 },
                "reasoning": true,
                "variants": {
                    "low": { "reasoningEffort": "low" },
                    "medium": { "reasoningEffort": "medium" },
                    "high": { "reasoningEffort": "high" }
                }
            },
            "antigravity-gemini-3.5-flash": {
                "name": "Gemini 3.5 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65536 },
                "reasoning": true,
                "variants": {
                    "low": { "reasoningEffort": "low" },
                    "medium": { "reasoningEffort": "medium" },
                    "high": { "reasoningEffort": "high" }
                }
            },
            "antigravity-gemini-3.1-pro": {
                "name": "Gemini 3.1 Pro (Antigravity)",
                "limit": { "context": 1048576, "output": 65535 },
                "reasoning": true,
                "variants": {
                    "low": { "reasoningEffort": "low" },
                    "high": { "reasoningEffort": "high" }
                }
            },
            "antigravity-claude-sonnet-4-6-thinking": {
                "name": "Claude Sonnet 4.6 Thinking (Antigravity)",
                "limit": { "context": 200000, "output": 64000 }
            },
            "antigravity-claude-opus-4-6-thinking": {
                "name": "Claude Opus 4.6 Thinking (Antigravity)",
                "limit": { "context": 1000000, "output": 64000 }
            },
            "antigravity-gpt-oss-120b": {
                "name": "GPT-OSS 120B (Antigravity)",
                "limit": { "context": 128000, "output": 32768 }
            }
        }
    }
}
```

### Thinking Levels

In OpenCode, use `Ctrl+T` (the `variant_cycle` keybind) to switch between the
`low`, `medium`, and `high` variants declared above. OpenCode sends the selected
variant as the standard `reasoning_effort` request field, which the proxy maps to
the corresponding Antigravity thinking level.

Other OpenAI-compatible clients can set `reasoning_effort` directly or append a
thinking level to the model ID:

| Model | Levels | Default |
| --- | --- | --- |
| `antigravity-gemini-3.7-flash` | `low`, `medium`, `high` | `medium` |
| `antigravity-gemini-3.6-flash` | `low`, `medium`, `high` | `medium` |
| `antigravity-gemini-3.5-flash` | `low`, `medium`, `high` | `medium` |
| `antigravity-gemini-3.1-pro` | `low`, `high` | `high` |
| `antigravity-claude-sonnet-4-6-thinking` | Fixed thinking | Thinking |
| `antigravity-claude-opus-4-6-thinking` | Fixed thinking | Thinking |
| `antigravity-gpt-oss-120b` | Fixed | `medium` |

For example, use `antigravity-gemini-3.7-flash-high` or
`antigravity-gemini-3.1-pro-low`. The base model ID selects the default shown
above.

## How It Works

Antigravity Proxy acts as a sophisticated bridge that translates OpenAI-formatted requests into Google's internal RPC protocols. It manages the complexities of authentication, session handling, and response streaming, allowing you to use high-tier models with your favorite tools.

### Account Selection

Account routing uses persistent session affinity rather than a user-selectable
rotation strategy. A previously successful `session + model` binding is reused
first. When there is no binding or the bound account must fail over, eligible
accounts are ranked by health and idle time before a new binding is persisted.

## Security Notes
- **Safety Filters**: Controlled via `SAFETY_THRESHOLD` (default: `BLOCK_NONE`).
- **Antigravity credentials**: OAuth tokens are stored locally in `antigravity-accounts.json`. Do not share or commit this file.
- **Codex credentials**: Codex OAuth tokens are stored separately in `data/codex-accounts.json` by default. `data/` is ignored by Git; keep any custom `CODEX_ACCOUNTS_FILE` private as well.
- **Device-code login**: Only the verification URL, one-time user code, status, and login ID are exposed to the dashboard. Token polling and token exchange stay server-side.
