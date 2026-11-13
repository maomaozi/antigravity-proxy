# Antigravity Hub 2.31.2 protocol verification

Verified on 2026-11-13 using the unmodified Linux ARM `language_server`
from the official 2.31.2 package, build `1019359392`.

The executable ran with isolated credentials and configuration directories.
A loopback forwarder recorded its outbound requests. Discovery requests were
forwarded to the official service. Generation requests received a controlled
SSE response locally, allowing inspection of native generation formatting
without forwarding the agent's built-in tools or prompts to a live model.
Credentials were redacted and temporary login files removed.

Native application headers:

```http
Authorization: Bearer [REDACTED]
Content-Type: application/json
User-Agent: antigravity/hub/2.31.2 (aidev_client; os_type=linux; arch=arm64; cl=1019359392; datacollection_opt_in=false)
```

HTTP transfer framing is managed by the transport. The native executable used
chunked request bodies; application-level headers did not include the proxy's
previous IDE/device metadata or Anthropic beta header.

Agent requests use `project`, `model`, `userAgent: "antigravity"`,
`requestType: "agent"`, `requestId`, and `request`. The request ID has the form
`agent/<cascade UUID>/<timestamp>/<trajectory UUID>/<step>`.
`request.sessionId` is a signed decimal string. `request.labels` includes
cascade, trajectory, model enum, step, and provider flags. The proxy generates
internally consistent labels, keeps session/cascade identity stable for its
client session, and creates fresh trajectory/request IDs for each request.

The proxy preserves caller messages, tool schemas, and explicit output limits;
it does not copy the native agent's system prompt or its built-in tools.

| Captured model | Native max output tokens | Thinking configuration |
| --- | ---: | --- |
| Gemini 3.8 Flash High | 65536 | `includeThoughts: true`, `thinkingLevel: "HIGH"` |
| Gemini 4 Hydrogen XHigh | 262144 | `includeThoughts: true`, `thinkingLevel: 100` |
| Orchestrator (Argon) | 65536 | `includeThoughts: true`, `thinkingLevel: "HIGH"` |
| Claude Sonnet 5.5 High | 128000 | `includeThoughts: true`, `thinkingLevel: "HIGH"` |
| GPT-OSS 120B Medium | 32768 | `includeThoughts: true`, `thinkingBudget: 8192` |

For these agent requests, the native client omitted temperature, top-p,
candidate count, safety settings, and forced function-calling mode. Tools
contained one function declaration per tool entry. The proxy follows this
layout, preserves its existing Claude JSON Schema translation, and honors an
explicit `SAFETY_THRESHOLD` environment override when configured.

Discovery retains the upstream model enum, thinking level, and output limit.
In a same-account live discovery comparison, the old 2.29.0 User-Agent returned
31 entries and omitted Orchestrator and Flash Worker; the verified 2.31.2
User-Agent returned 33 entries including both. Thus frontend visibility also
depends on using a sufficiently recent client identifier for discovery.

These observations verify the request format. The controlled native capture
does not establish live generation success for every model, nor how an
Orchestrator invocation accounts for delegated Hydrogen quota.

Live proxy smoke checks on the same date returned HTTP 200 and `OK` for
Gemini 3.8 Flash High, Orchestrator (Argon), Hydrogen XHigh, Claude Sonnet 5.5
High, and GPT-OSS 120B Medium, each with an explicit 128-token output limit.
The Claude and GPT-OSS checks included two function tool declarations.
Browser checks confirmed shared pool cards,
Orchestrator visibility, the XHigh selector, preserved Image Studio access,
and no page-level horizontal overflow at a 390-pixel viewport width.
