import { describe, expect, test } from "bun:test";
import { resolveCodexModel } from "../../src/codex/routing";

describe("Codex model routing", () => {
  test("routes explicit codex namespace without colliding with Antigravity GPT models", () => {
    expect(resolveCodexModel("codex/gpt-5-codex", [])).toEqual({ provider: "codex", upstreamModel: "gpt-5-codex" });
    expect(resolveCodexModel("antigravity-gpt-oss-120b", [])).toEqual({ provider: "antigravity", upstreamModel: "antigravity-gpt-oss-120b" });
  });

  test("routes only explicitly configured raw Codex model IDs", () => {
    expect(resolveCodexModel("gpt-5-codex", ["gpt-5-codex"])).toEqual({ provider: "codex", upstreamModel: "gpt-5-codex" });
    expect(resolveCodexModel("gpt-random", ["gpt-5-codex"])).toEqual({ provider: "antigravity", upstreamModel: "gpt-random" });
  });
});
