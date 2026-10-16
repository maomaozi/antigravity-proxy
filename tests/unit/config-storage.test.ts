import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(new URL("../../src/config/manager.ts", import.meta.url));
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function tempDirectory() {
  const dir = await mkdtemp(join(tmpdir(), "proxy-config-"));
  dirs.push(dir);
  return dir;
}
async function loadConfigInChild(cwd: string) {
  const child = Bun.spawn([process.execPath, "-e", `const {loadProxyConfig} = await import(${JSON.stringify(modulePath)}); const config = await loadProxyConfig(); console.log(JSON.stringify({refreshIntervalMs: config.quota.refreshIntervalMs}));`], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

describe("proxy configuration recovery", () => {
  test("restores a valid backup and keeps the configured values", async () => {
    const dir = await tempDirectory();
    await writeFile(join(dir, "config.json"), Buffer.alloc(500));
    await writeFile(join(dir, "config.json.bak"), JSON.stringify({ quota: { refreshIntervalMs: 12345 } }));
    const result = await loadConfigInChild(dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"refreshIntervalMs":12345');
    expect(JSON.parse(await readFile(join(dir, "config.json"), "utf8"))).toEqual({ quota: { refreshIntervalMs: 12345 } });
  });

  test("unrecoverable configuration fails startup without writing defaults", async () => {
    const dir = await tempDirectory();
    await writeFile(join(dir, "config.json"), "corrupt");
    const result = await loadConfigInChild(dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing to overwrite");
    expect(await readFile(join(dir, "config.json"), "utf8")).toBe("corrupt");
  });
});
