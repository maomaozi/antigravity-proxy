import { describe, expect, test } from "bun:test";
import { ANTIGRAVITY_MODEL_CATALOG } from "../../src/models";

const app = await Bun.file(new URL("../../src/frontend/js/app.js", import.meta.url)).text();
function render(catalog: unknown) {
  const elements = Object.fromEntries(["gemini-model-grid", "gemini-catalog-verification", "gemini-catalog-notice", "gemini-catalog-history"].map(id => [id, { innerHTML: "", textContent: "" }]));
  const renderCatalog = new Function("window", "document", `${app}; return renderGeminiCatalog;`)({}, { getElementById: (id: string) => elements[id] });
  renderCatalog(catalog);
  return elements;
}

describe("Gemini directory display", () => {
  test("separates callable chat/image models from retired models and aliases", () => {
    const elements = render(ANTIGRAVITY_MODEL_CATALOG);
    const active = elements["gemini-model-grid"].innerHTML;
    const history = elements["gemini-catalog-history"].innerHTML;
    expect(active).toContain("antigravity-gemini-3.5-flash-lite");
    expect(active).not.toContain('data-model-id="antigravity-gemini-3.5-flash"');
    expect(active).not.toContain('data-model-id="gemini-2.5-pro"');
    expect(active).toContain('data-model-id="gemini-3.1-flash-image"');
    expect(history).toContain("已停用");
    expect(history).toContain("容量不足");
    expect(history).toContain("gemini-2.5-flash-thinking");
    expect(elements["gemini-catalog-verification"].textContent).toContain("4 个聊天模型 / 1 个图片模型");
  });
  test("escapes model names and IDs before inserting catalog HTML", () => {
    const elements = render({ ...ANTIGRAVITY_MODEL_CATALOG, chatModels: [{ name: '<img src=x onerror="alert(1)">', id: 'bad" onclick="alert(1)', thinkingLevels: [] }] });
    expect(elements["gemini-model-grid"].innerHTML).not.toContain('<img src=x');
    expect(elements["gemini-model-grid"].innerHTML).toContain('&lt;img');
    expect(elements["gemini-model-grid"].innerHTML).toContain('bad&quot; onclick=&quot;');
  });
});
