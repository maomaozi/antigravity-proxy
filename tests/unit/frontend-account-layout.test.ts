import { describe, expect, test } from "bun:test";

const header = await Bun.file(new URL("../../src/frontend/components/header.html", import.meta.url)).text();
const main = await Bun.file(new URL("../../src/frontend/components/main.html", import.meta.url)).text();

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
});
