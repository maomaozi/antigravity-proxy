import { describe, expect, test } from "bun:test";

const header = await Bun.file(new URL("../../src/frontend/components/header.html", import.meta.url)).text();
const main = await Bun.file(new URL("../../src/frontend/components/main.html", import.meta.url)).text();
const app = await Bun.file(new URL("../../src/frontend/js/app.js", import.meta.url)).text();

describe("dashboard account provider layout", () => {
  test("keeps provider login actions out of the global header", () => {
    expect(header).not.toContain('href="/oauth/start"');
    expect(header).not.toContain("ADD ACCOUNT");
  });

  test("renders Google and Codex account pools at the same dashboard hierarchy", () => {
    expect(main).toContain('id="google-accounts-section"');
    expect(main).toContain('id="codex-accounts-section"');
    expect(main).toContain("Google Accounts");
    expect(main).toContain('href="/oauth/start"');
    expect(main).toContain("Add Google Account");
    expect(main).toContain("Add Codex Account");
  });

  test("exposes Codex quota usage and reset controls in the account table", () => {
    expect(main).toContain("Refresh Usage");
    expect(main).toContain(">Usage</th>");
    expect(main).toContain(">Reset</th>");
  });

  test("renders Codex quota windows with Google-style remaining bars", () => {
    expect(app).toContain("codexQuotaBarClass");
    expect(app).toContain("% left");
  });

  test("includes configured Codex models in the top family cards", () => {
    expect(app).toContain("globalCodexModels");
    expect(app).toContain("Codex Models");
    expect(app).toContain("calculateCodexFamilyStat");
    expect(app).toContain("renderDashboardFamilies");
    expect(main).toContain("lg:grid-cols-5");
  });
  test("keeps mobile dashboard on natural document scrolling", async () => {
    const index = await Bun.file(new URL("../../src/frontend/index.html", import.meta.url)).text();
    expect(index).toContain("min-h-full lg:h-full");
    expect(index).toContain("lg:overflow-hidden");
    expect(index).not.toContain("h-[calc(100vh-4rem)]");
    expect(main).toContain("lg:overflow-y-auto");
    expect(main).not.toContain('<div class="flex-grow overflow-y-auto bg-zinc-50');
    expect(main).toContain('id="logs-resizer" class="hidden lg:block');
  });

  test("expands one metric family when its card is tapped", () => {
    expect(app).toContain('onclick="toggleFamily(${index})"');
  });

});
