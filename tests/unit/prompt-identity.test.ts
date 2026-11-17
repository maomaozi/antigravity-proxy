import { beforeAll, describe, expect, test } from "bun:test";
import { adaptResponsesRequest } from "../../src/api/openai/responses";
import { loadProxyConfig } from "../../src/config/manager";
import { resolveCodexAffinityIdentity } from "../../src/session/identity";
import {
  ANTIGRAVITY_CODING_IDENTITY,
  ANTIGRAVITY_SHORT_IDENTITY,
  CODEX_FALLBACK_RULE_ID,
  KNOWN_IDENTITY_TEMPLATE_RULES,
  PROMPT_IDENTITY_RULESET_VERSION,
  replaceSystemPromptIdentity,
} from "../../src/utils/prompt-identity";
import { transformCompletionToGoogleBody } from "../../src/utils/transform";

beforeAll(async () => {
  await loadProxyConfig();
});

describe("system prompt identity replacement", () => {
  test.each([
    "You are Codex, a coding agent.",
    "You are Codex, an agent based on GPT-5.",
    "You are Codex, an agent based on GPT-6.",
    "You are Codex, a coding agent based on GPT-5.",
    "You are Codex, a coding agent based on GPT-6.1-terra.",
    "a coding agent based on GPT-5.6-sol.",
    "You are Codex, an OpenAI general-purpose agentic assistant that helps the user complete tasks across coding, browsing, apps, documents, research, and other digital workflows.",
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.",
  ])("replaces known local Codex identity template %s accurately and idempotently", (template) => {
    const trailing = " You and the user share one workspace.\n\n# General\nFollow repository conventions.";
    const input = `${template}${trailing}`;
    const first = replaceSystemPromptIdentity(input);

    expect(first.replaced).toBe(true);
    expect(first.version).toBe(PROMPT_IDENTITY_RULESET_VERSION);
    expect(first.totalHits).toBe(1);
    expect(first.text).toBe(`${ANTIGRAVITY_CODING_IDENTITY}${trailing}`);
    expect(first.text).not.toContain(".,");
    expect(first.text).not.toContain("..");

    const second = replaceSystemPromptIdentity(first.text);
    expect(second.replaced).toBe(false);
    expect(second.totalHits).toBe(0);
    expect(second.text).toBe(first.text);
  });

  test("prefers longer specific rules over shorter prefix rules", () => {
    const ruleIds = KNOWN_IDENTITY_TEMPLATE_RULES.map(rule => rule.id);
    expect(ruleIds.indexOf("codex-gpt-coding-agent-v1")).toBeLessThan(
      ruleIds.indexOf("codex-coding-agent-v1"),
    );

    const input = "You are Codex, a coding agent based on GPT-6. Keep responses concise.";
    const result = replaceSystemPromptIdentity(input);
    expect(result.text).toBe(`${ANTIGRAVITY_CODING_IDENTITY} Keep responses concise.`);
    expect(result.text).not.toContain("based on GPT-6");
    expect(result.ruleHits["codex-gpt-coding-agent-v1"]).toBe(1);
  });

  test("does not match across newlines with constrained GPT version token and preserves subsequent task rules", () => {
    const input = "You are Codex, an agent based on GPT-6\nDo not delete production data.";
    const result = replaceSystemPromptIdentity(input);
    expect(result.replaced).toBe(true);
    expect(result.ruleHits[CODEX_FALLBACK_RULE_ID]).toBe(1);
    expect(result.text).toBe("You are Antigravity, an agent based on GPT-6\nDo not delete production data.");
  });

  test("falls back to replacing 'You are Codex' when no specific identity template matches", () => {
    const customSentence = "You are Codex, an experimental workspace partner. Keep answers concise.";
    const customResult = replaceSystemPromptIdentity(customSentence);
    expect(customResult.replaced).toBe(true);
    expect(customResult.ruleHits[CODEX_FALLBACK_RULE_ID]).toBe(1);
    expect(customResult.text).toBe(`${ANTIGRAVITY_SHORT_IDENTITY}, an experimental workspace partner. Keep answers concise.`);
    expect(replaceSystemPromptIdentity(customResult.text).replaced).toBe(false);

    const standalone = "You are Codex. Follow repo conventions.";
    const standaloneResult = replaceSystemPromptIdentity(standalone);
    expect(standaloneResult.replaced).toBe(true);
    expect(standaloneResult.ruleHits[CODEX_FALLBACK_RULE_ID]).toBe(1);
    expect(standaloneResult.text).toBe(`${ANTIGRAVITY_CODING_IDENTITY} Follow repo conventions.`);
    expect(replaceSystemPromptIdentity(standaloneResult.text).replaced).toBe(false);

    const midLineAndQuoted = "In this session, You are Codex helping users, not `You are Codex` or \"You are Codex\".";
    const midLineResult = replaceSystemPromptIdentity(midLineAndQuoted);
    expect(midLineResult.replaced).toBe(true);
    expect(midLineResult.ruleHits[CODEX_FALLBACK_RULE_ID]).toBe(1);
    expect(midLineResult.text).toBe("In this session, You are Antigravity helping users, not `You are Codex` or \"You are Codex\".");
  });

  test("preserves unknown identities and ordinary natural-language Codex mentions", () => {
    const inputs = [
      "You are CustomHelper, a coding agent. Always verify tests.",
      "Review how Codex CLI manages MCP servers before editing.",
      "Do not confuse Codex behavior with local shell hooks.",
    ];
    for (const input of inputs) {
      const result = replaceSystemPromptIdentity(input);
      expect(result.replaced).toBe(false);
      expect(result.totalHits).toBe(0);
      expect(result.text).toBe(input);
    }
  });

  test("preserves paths, env vars, tool namespaces, code blocks, blockquotes, and quoted examples", () => {
    const prompt = [
      "You are Codex, a coding agent.",
      "",
      "Check `/home/maozi/.codex/skills/.system` and `/home/maozi/.codex/plugins/cache/openai-curated-remote`.",
      "Read skills under `$CODEX_HOME/skills`.",
      "Available namespaces: `mcp__codex_apps__github` and `mcp__codex_tui`.",
      "",
      "For example:",
      "You are Codex, a coding agent.",
      "",
      "> You are Codex, an agent based on GPT-6.",
      "\"You are Codex, a coding agent.\"",
      "",
      "```markdown",
      "You are Codex, a coding agent.",
      "You are Codex, an agent based on GPT-6.",
      "```",
    ].join("\n");

    const result = replaceSystemPromptIdentity(prompt);
    expect(result.totalHits).toBe(1);
    expect(result.text.startsWith(`${ANTIGRAVITY_CODING_IDENTITY}\n`)).toBe(true);
    expect(result.text).toContain("/home/maozi/.codex/skills/.system");
    expect(result.text).toContain("/home/maozi/.codex/plugins/cache/openai-curated-remote");
    expect(result.text).toContain("$CODEX_HOME/skills");
    expect(result.text).toContain("mcp__codex_apps__github");
    expect(result.text).toContain("mcp__codex_tui");
    expect(result.text).toContain("For example:\nYou are Codex, a coding agent.");
    expect(result.text).toContain("> You are Codex, an agent based on GPT-6.");
    expect(result.text).toContain("\"You are Codex, a coding agent.\"");
    expect(result.text).toContain("```markdown\nYou are Codex, a coding agent.\nYou are Codex, an agent based on GPT-6.\n```");
  });

  test("covers multi-turn system/developer instructions in /v1/responses transform without changing session identity or tool names", () => {
    const responsesBody = {
      model: "antigravity-gemini-4-argon",
      instructions: "You are Codex, a coding agent.",
      input: [
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: [
                "You are Codex, an agent based on GPT-6. Follow workspace rules.",
                "Skills path: /home/maozi/.codex/skills/.system and $CODEX_HOME/skills.",
                "Use mcp__codex_apps__github when needed.",
              ].join("\n"),
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Check Codex config and run tool" }],
        },
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "You are Codex, a coding agent based on GPT-6." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue" }],
        },
      ],
      tools: [
        {
          type: "namespace",
          name: "mcp__codex_apps__github",
          description: "GitHub tools for Codex workspace.",
          tools: [
            {
              type: "function",
              name: "list_issues",
              description: "List issues",
              parameters: { type: "object", properties: { repo: { type: "string" } } },
            },
          ],
        },
      ],
    };

    const adapted = adaptResponsesRequest(responsesBody);
    const identityBeforeTransform = resolveCodexAffinityIdentity(new Headers(), responsesBody, adapted.messages);
    const googleBody = transformCompletionToGoogleBody(adapted, "project-1", "", identityBeforeTransform.key);
    const identityAfterTransform = resolveCodexAffinityIdentity(new Headers(), responsesBody, adapted.messages);

    expect(identityAfterTransform.key).toBe(identityBeforeTransform.key);

    const systemText = googleBody.request.systemInstruction.parts[0].text as string;
    expect(systemText).not.toContain("You are Codex, a coding agent.");
    expect(systemText).not.toContain("You are Codex, an agent based on GPT-6.");
    expect(systemText).not.toContain("You are Codex, a coding agent based on GPT-6.");
    expect(systemText).toContain(ANTIGRAVITY_CODING_IDENTITY);
    expect(systemText).toContain("/home/maozi/.codex/skills/.system");
    expect(systemText).toContain("$CODEX_HOME/skills");
    expect(systemText).toContain("mcp__codex_apps__github");

    // User messages and real tool declarations remain intact.
    expect(googleBody.request.contents[0].parts[0].text).toBe("Check Codex config and run tool");
    const toolDecl = googleBody.request.tools[0].functionDeclarations[0];
    expect(toolDecl.description).toContain("[Responses namespace: mcp__codex_apps__github]");
  });
});
