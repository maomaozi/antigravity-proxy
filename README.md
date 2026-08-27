# Antigravity Proxy

![Antigravity Proxy Dashboard](screenshots/screenshot.png)

Antigravity Proxy is a high-performance gateway that exposes Google's internal Gemini, Claude, and GPT-OSS APIs through an **OpenAI-compatible interface**. It enables seamless integration between advanced models and CLI agents (such as **OpenCode** or **Claude Code**), as well as any application supporting the OpenAI API standard.

This project is strongly inspired by [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth).

## Features

- **OpenAI API Compatibility**: Full support for `v1/chat/completions` with streaming (SSE).
- **Multi-Agent Support**: Specifically designed to work with **Claude Code**, **OpenCode**, and other agentic frameworks.
- **Account Rotation & Health Scoring**: Automatically rotates multiple Google accounts, penalizing those with errors and favoring healthy ones.
- **Quota Management**: Real-time monitoring and automatic cooldowns (backoff) on `429 Too Many Requests` errors.
- **Dual-Pool Routing**:
  - **CLI Pool**: Routes to production Gemini endpoints.
  - **Sandbox Pool**: Accesses Antigravity Gemini, Claude Thinking, and GPT-OSS models.
- **Integrated Dashboard**: Manage accounts, monitor health, and view real-time logs via a built-in web interface.
- **Automatic Project Discovery**: Auto-detects Google Cloud Project IDs via Cloud SDK impersonation.

## Deployment Options

### Bunx (Recommended)
You can run the proxy instantly using `bunx`:
```bash
bunx antigravity-proxy@0.7.0
```

### Docker Hub
```bash
docker run -d -p 3000:3000 -e BASE_URL=http://localhost:3000 --name antigravity-proxy frieserpaldi/antigravity-proxy:0.7.0
```

### Local Execution (Bun)
Requirements: Bun (v1.0.0 or higher).
```bash
bun install
bun run start
```
The server starts on port 3000.

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
                "limit": { "context": 1048576, "output": 65536 }
            },
            "antigravity-gemini-3.6-flash": {
                "name": "Gemini 3.6 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65536 }
            },
            "antigravity-gemini-3.5-flash": {
                "name": "Gemini 3.5 Flash (Antigravity)",
                "limit": { "context": 1048576, "output": 65536 }
            },
            "antigravity-gemini-3.1-pro": {
                "name": "Gemini 3.1 Pro (Antigravity)",
                "limit": { "context": 1048576, "output": 65535 }
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

Select a Gemini thinking level by appending it to the model ID:

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

### Account Selection Strategy
- **Hybrid (Default)**: Ranks accounts based on `(Health Score × 2) + (Idle Time × 0.1)`.
- **Sticky**: Keeps a client session tied to the same account for consistency.
- **Round-Robin**: Cycles through all available accounts evenly.

## Security Notes
- **Safety Filters**: Controlled via `SAFETY_THRESHOLD` (default: `BLOCK_NONE`).
- **Credentials**: OAuth tokens are stored locally in `antigravity-accounts.json`. Do not share or commit this file.
