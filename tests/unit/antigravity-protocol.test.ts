import { beforeAll, describe, expect, test } from "bun:test";
import { loadProxyConfig } from "../../src/config/manager";
import { createAntigravityRequestContext } from "../../src/utils/antigravity-protocol";
import { transformCompletionToGoogleBody } from "../../src/utils/transform";
import { validateResponsesRequest } from "../../src/api/openai/responses";
import { findAccountModel, getAccountModelPool, getAvailableModelCatalog } from "../../src/models";
import type { AntigravityAccount } from "../../src/auth/types";

beforeAll(loadProxyConfig);

describe("native Hub 2.31.2 generation protocol", () => {
  // These configurations were captured from the official language_server using
  // a loopback forwarder with a controlled SSE response (no upstream generation).
  test.each([
    ["gemini-3.8-flash-high", "MODEL_PLACEHOLDER_M318", 65536, 3, { includeThoughts: true, thinkingLevel: "HIGH" }],
    ["gemini-4-hydrogen-xhigh", "MODEL_PLACEHOLDER_M528", 262144, 100, { includeThoughts: true, thinkingLevel: 100 }],
    ["gemini-pro-orchestrator-g1-pro", "MODEL_PLACEHOLDER_M668", 65536, 3, { includeThoughts: true, thinkingLevel: "HIGH" }],
    ["claude-sonnet-5-5-high", "MODEL_PLACEHOLDER_M405", 128000, 3, { includeThoughts: true, thinkingLevel: "HIGH" }],
    ["gpt-oss-120b-medium", "MODEL_OPENAI_GPT_OSS_120B_MEDIUM", 32768, undefined, { includeThoughts: true, thinkingBudget: 8192 }],
  ] as const)("matches the captured generation configuration for %s", (id, modelEnum, maxOutputTokens, thinkingLevel, thinkingConfig) => {
    const body = transformCompletionToGoogleBody({
      model: `antigravity-${id}`, messages: [{ role: "user", content: "Reply OK" }], stream: true,
      tools: [{ name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } }, { name: "finish" }],
    }, "project", "", "conversation", false, { id, name: id, supportsThinking: true, modelEnum, maxOutputTokens, thinkingLevel });
    expect(body.model).toBe(id);
    expect(body.request.generationConfig).toEqual({ maxOutputTokens, stopSequences: undefined, thinkingConfig });
    expect(body.request.tools).toHaveLength(2);
    expect(body.request.tools.every((tool: any) => tool.functionDeclarations.length === 1)).toBe(true);
    expect(body.request.toolConfig).toBeUndefined();
    expect(body.request.labels.model_enum).toBe(modelEnum);
    expect(body.request.labels.used_claude).toBe(String(id.includes("claude")));
    expect(body.requestId).toMatch(/^agent\/[\da-f-]{36}\/\d+\/[\da-f-]{36}\/1$/);
    expect(body.request.sessionId).toMatch(/^-?\d+$/);
    expect(body.request.contents).toEqual([{ role: "user", parts: [{ text: "Reply OK" }] }]);
  });

  test("keeps session and cascade IDs stable while making each request unique", () => {
    const first = createAntigravityRequestContext("conversation-a", "gemini-3.8-flash-high");
    const next = createAntigravityRequestContext("conversation-a", "gemini-3.8-flash-high");
    const other = createAntigravityRequestContext("conversation-b", "gemini-3.8-flash-high");
    expect(first.sessionId).toBe(next.sessionId);
    expect(first.labels.cascade_id).toBe(next.labels.cascade_id);
    expect(first.requestId).not.toBe(next.requestId);
    expect(first.sessionId).not.toBe(other.sessionId);
    expect(BigInt(first.sessionId)).toBe(BigInt.asIntN(64, BigInt(first.sessionId)));
  });

  test("discovers XHigh as a thinking tier and maps Hydrogen and Orchestrator to their shared pools", () => {
    const account = {
      refreshToken: "refresh", availableModels: [
        { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
        { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
        { id: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
      ],
      quotaWindows: [
        { groupName: "Gemini Models", window: "weekly", remainingFraction: 0 },
        { groupName: "Gemini 4 Argon", window: "weekly", remainingFraction: 0.5 },
      ],
    } as AntigravityAccount;
    expect(findAccountModel(account, "antigravity-gemini-4-hydrogen", "xhigh")?.id).toBe("gemini-4-hydrogen-xhigh");
    expect(getAvailableModelCatalog([account]).find(model => model.id === "antigravity-gemini-4-hydrogen")?.thinkingLevels).toEqual(["high", "xhigh"]);
    expect(getAvailableModelCatalog([account]).some(model => model.name === "Orchestrator (Argon)")).toBe(true);
    expect(getAccountModelPool(account, "gemini-4-hydrogen-xhigh")).toBe("Gemini Models");
    expect(getAccountModelPool(account, "gemini-pro-orchestrator-g1-pro")).toBe("Gemini 4 Argon");
    account.quotaWindows = account.quotaWindows!.slice(0, 1);
    expect(getAccountModelPool(account, "gemini-pro-orchestrator-g1-pro")).toBe("Gemini Models");
    expect(validateResponsesRequest({ model: "antigravity-gemini-4-hydrogen", input: "hi", reasoning: { effort: "xhigh" } })).toBeUndefined();
  });
});
