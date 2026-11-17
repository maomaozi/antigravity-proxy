/**
 * Versioned identity template replacement for system instructions sent to Antigravity.
 *
 * Local identity baselines verified from:
 * - `/home/maozi/.local/bin/agy` (v1.5.9, `antigravity_identity` template block)
 * - `/home/maozi/.local/bin/codex` (v0.169.0, embedded `instructions_template` catalog)
 * - `~/.codex/{gemini,antigravity,glm}-models.json` and rollout session metadata
 */

export const PROMPT_IDENTITY_RULESET_VERSION = "2026-11-17.v2";

export const ANTIGRAVITY_SHORT_IDENTITY = "You are Antigravity";

export const CODEX_FALLBACK_RULE_ID = "codex-you-are-fallback-v1";

/** Default coding-assistant identity sentence from AGY `antigravity_identity` template. */
export const ANTIGRAVITY_CODING_IDENTITY =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.";

/** Generic assistant identity sentence from AGY `generic-system-prompt` experiment branch. */
export const ANTIGRAVITY_GENERIC_IDENTITY =
  "You are Antigravity, a powerful agentic AI assistant designed by the Google Deepmind team.";

/** Legacy/alternate agent identity sentence present in AGY binary strings. */
export const ANTIGRAVITY_AGENT_IDENTITY =
  "You are Antigravity Agent, a powerful agentic AI coding assistant designed by the Google engineering team.";

/**
 * Constrained single-line GPT version token (e.g. GPT-5, GPT-6, GPT-5.6-sol, GPT-6.1-terra).
 * Never consumes trailing sentence punctuation, whitespace, or newlines.
 */
const GPT_VERSION_TOKEN = "GPT-[0-9A-Za-z]+(?:[._-][0-9A-Za-z]+)*";

export interface PromptIdentityTemplateRule {
  id: string;
  description: string;
  /** Matches at the start of an eligible identity declaration line. */
  pattern: RegExp;
  replacement: string;
}

/**
 * Ordered longest / most specific first so composite templates match before shorter prefixes.
 * Each rule consumes its terminal period (or clause-ending comma before whitespace) so the
 * replacement sentence never leaves dangling `.,` or `..` punctuation.
 */
export const KNOWN_IDENTITY_TEMPLATE_RULES: readonly PromptIdentityTemplateRule[] = [
  {
    id: "codex-cli-open-source-v1",
    description: "Codex CLI open-source terminal coding assistant two-sentence identity header",
    pattern: new RegExp(
      "^You are a coding agent running in the Codex CLI, a terminal-based coding assistant\\.[ \\t]+Codex CLI is an open source project led by OpenAI(?:\\.+[.,]*|,(?=\\s))",
    ),
    replacement: ANTIGRAVITY_CODING_IDENTITY,
  },
  {
    id: "codex-general-agentic-v1",
    description: "Codex 0.169+ general-purpose agentic assistant identity sentence",
    pattern: new RegExp(
      "^You are Codex, an OpenAI general-purpose agentic assistant that helps the user complete tasks across coding, browsing, apps, documents, research, and other digital workflows(?:\\.+[.,]*|,(?=\\s))",
    ),
    replacement: ANTIGRAVITY_CODING_IDENTITY,
  },
  {
    id: "codex-gpt-coding-agent-v1",
    description: "Codex coding agent based on GPT-<version> identity sentence and variants",
    pattern: new RegExp(
      `^(?:You are (?:Codex(?:\\s*[,:-]\\s*|\\s+))?a coding agent based on ${GPT_VERSION_TOKEN}|a coding agent based on ${GPT_VERSION_TOKEN})(?:\\.+[.,]*|,(?=\\s))`,
    ),
    replacement: ANTIGRAVITY_CODING_IDENTITY,
  },
  {
    id: "codex-gpt-agent-v1",
    description: "Codex agent based on GPT-<version> identity sentence",
    pattern: new RegExp(
      `^You are Codex, an agent based on ${GPT_VERSION_TOKEN}(?:\\.+[.,]*|,(?=\\s))`,
    ),
    replacement: ANTIGRAVITY_CODING_IDENTITY,
  },
  {
    id: "codex-coding-agent-v1",
    description: "Minimal Codex coding agent identity sentence from local model catalogs",
    pattern: new RegExp(
      "^You are Codex, a coding agent(?:\\.+[.,]*|,(?=\\s))",
    ),
    replacement: ANTIGRAVITY_CODING_IDENTITY,
  },
] as const;

export interface SystemPromptIdentityReplacementResult {
  text: string;
  replaced: boolean;
  version: string;
  totalHits: number;
  ruleHits: Record<string, number>;
}

const EXAMPLE_OR_QUOTE_INTRODUCER =
  /^(?:for example|example|examples|e\.g\.|quote|quoted|sample|samples|input|output|before|after|previously|比如|例如|示例|引用|原句|原文)\s*[:：]\s*$/i;

function isFenceLine(line: string): { char: "`" | "~"; length: number } | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const fence = match[1]!;
  return { char: fence[0] as "`" | "~", length: fence.length };
}

function isIdentityDeclarationLine(line: string, prevNonEmptyLine: string): { prefix: string; body: string } | null {
  if (!line) return null;
  // Indented lines, blockquotes, list items, headings, or quoted/inline-code lines are not identity declarations.
  if (/^[ \t>*+\-#"'`“‘]/.test(line) || /^\d+[.)]\s/.test(line)) {
    return null;
  }
  if ( prevNonEmptyLine && EXAMPLE_OR_QUOTE_INTRODUCER.test(prevNonEmptyLine.trim()) ) {
    return null;
  }

  let prefix = "";
  let body = line;
  const identityTagMatch = line.match(/^(<identity>\s*)/i);
  if (identityTagMatch) {
    prefix = identityTagMatch[1]!;
    body = line.slice(prefix.length);
  }

  // Reject lines wrapped in quotes or backticks.
  if (/^["'`“‘]/.test(body)) {
    return null;
  }

  return { prefix, body };
}

function dedupeLeadingAntigravityIdentity(text: string): string {
  const escaped = ANTIGRAVITY_CODING_IDENTITY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const duplicatePattern = new RegExp(`^(${escaped})(?:\\s*${escaped})+`);
  return text.replace(duplicatePattern, "$1");
}

function replaceUnquotedFallbackYouAreCodex(lineBody: string): { text: string; hits: number } {
  // Standalone "You are Codex." at declaration start upgrades cleanly to full coding identity.
  const standaloneMatch = lineBody.match(/^You are Codex\.+(?=\s|$)/);
  if (standaloneMatch) {
    const tail = lineBody.slice(standaloneMatch[0].length);
    return {
      text: `${ANTIGRAVITY_CODING_IDENTITY}${tail}`,
      hits: 1,
    };
  }

  // Otherwise replace unquoted/non-inline-code "You are Codex" occurrences with "You are Antigravity".
  let hits = 0;
  let result = "";
  let index = 0;
  while (index < lineBody.length) {
    const ch = lineBody[index]!;
    if (ch === "`" || ch === "\"" || ch === "“") {
      const closeChar = ch === "“" ? "”" : ch;
      const closeIndex = lineBody.indexOf(closeChar, index + 1);
      if (closeIndex !== -1) {
        result += lineBody.slice(index, closeIndex + 1);
        index = closeIndex + 1;
        continue;
      }
    }
    if (
      lineBody.startsWith("You are Codex", index)
      && (index === 0 || !/[A-Za-z0-9_]/.test(lineBody[index - 1]!))
      && (index + 13 >= lineBody.length || !/[A-Za-z0-9_]/.test(lineBody[index + 13]!))
    ) {
      result += ANTIGRAVITY_SHORT_IDENTITY;
      index += 13;
      hits++;
      continue;
    }
    result += ch;
    index++;
  }

  return { text: hits > 0 ? result : lineBody, hits };
}

/**
 * Replaces known Codex identity templates in `systemInstruction` text with the
 * Antigravity coding assistant identity sentence while preserving all non-matching
 * text, paths, environment variables, tool namespaces, code blocks, and quotes.
 */
export function replaceSystemPromptIdentity(text: string): SystemPromptIdentityReplacementResult {
  if (!text || typeof text !== "string") {
    return {
      text: text ?? "",
      replaced: false,
      version: PROMPT_IDENTITY_RULESET_VERSION,
      totalHits: 0,
      ruleHits: {},
    };
  }

  const ruleHits: Record<string, number> = {};
  let totalHits = 0;

  // Split preserving exact line breaks (\n or \r\n).
  const tokens = text.split(/(\r?\n)/);
  let activeFence: { char: "`" | "~"; length: number } | null = null;
  let prevNonEmptyLine = "";

  for (let i = 0; i < tokens.length; i += 2) {
    const line = tokens[i] ?? "";
    const fence = isFenceLine(line);
    if (fence) {
      if (!activeFence) {
        activeFence = fence;
      } else if (activeFence.char === fence.char && fence.length >= activeFence.length && /^[ \t]{0,3}[`~]+[ \t]*$/.test(line)) {
        activeFence = null;
      }
      if (line.trim()) prevNonEmptyLine = line;
      continue;
    }

    if (activeFence) {
      if (line.trim()) prevNonEmptyLine = line;
      continue;
    }

    const candidate = isIdentityDeclarationLine(line, prevNonEmptyLine);
    if (candidate) {
      let currentBody = dedupeLeadingAntigravityIdentity(candidate.body);
      let prefixForRules = candidate.prefix;

      // If the line already starts with the target Antigravity identity followed by a known template,
      // allow stripping the redundant template so the output remains clean and idempotent.
      if (currentBody.startsWith(ANTIGRAVITY_CODING_IDENTITY)) {
        const afterIdentity = currentBody.slice(ANTIGRAVITY_CODING_IDENTITY.length);
        const spaceMatch = afterIdentity.match(/^([ \t]+)/);
        if (spaceMatch) {
          const remainder = afterIdentity.slice(spaceMatch[1]!.length);
          for (const rule of KNOWN_IDENTITY_TEMPLATE_RULES) {
            const match = remainder.match(rule.pattern);
            if (match) {
              const matchedText = match[0]!;
              const tail = remainder.slice(matchedText.length).replace(/^[.,]+(?=\s|$)/, "");
              currentBody = `${ANTIGRAVITY_CODING_IDENTITY}${tail}`;
              ruleHits[rule.id] = (ruleHits[rule.id] || 0) + 1;
              totalHits++;
              break;
            }
          }
        }
        tokens[i] = `${prefixForRules}${currentBody}`;
      } else {
        let matchedKnownRule = false;
        for (const rule of KNOWN_IDENTITY_TEMPLATE_RULES) {
          const match = currentBody.match(rule.pattern);
          if (!match) continue;
          const matchedText = match[0]!;
          let tail = currentBody.slice(matchedText.length);
          // Clean any residual punctuation like `.,` or `..` immediately after the matched template.
          tail = tail.replace(/^[.,]+(?=\s|$)/, "");
          if (tail && !/^\s/.test(tail) && !/^[<\])]/.test(tail)) {
            tail = ` ${tail}`;
          }
          const replacedBody = dedupeLeadingAntigravityIdentity(`${rule.replacement}${tail}`);
          tokens[i] = `${prefixForRules}${replacedBody}`;
          ruleHits[rule.id] = (ruleHits[rule.id] || 0) + 1;
          totalHits++;
          matchedKnownRule = true;
          break;
        }
        if (!matchedKnownRule && currentBody.includes("You are Codex")) {
          const fallback = replaceUnquotedFallbackYouAreCodex(currentBody);
          if (fallback.hits > 0) {
            tokens[i] = `${prefixForRules}${fallback.text}`;
            ruleHits[CODEX_FALLBACK_RULE_ID] = (ruleHits[CODEX_FALLBACK_RULE_ID] || 0) + fallback.hits;
            totalHits += fallback.hits;
          }
        }
      }
    }

    if (line.trim()) {
      prevNonEmptyLine = tokens[i]!;
    }
  }

  const finalText = totalHits > 0 ? tokens.join("") : text;
  return {
    text: finalText,
    replaced: totalHits > 0 && finalText !== text,
    version: PROMPT_IDENTITY_RULESET_VERSION,
    totalHits,
    ruleHits,
  };
}
