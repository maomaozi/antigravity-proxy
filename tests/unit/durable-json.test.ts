import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDurableJson, writeDurableJson } from "../../src/utils/durable-json";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), "durable-json-"));
  dirs.push(dir);
  return join(dir, "accounts.json");
}
function decode(value: unknown): { revision: number } {
  if (!value || typeof (value as any).revision !== "number") throw new Error("Invalid revision");
  return value as { revision: number };
}

describe("durable JSON persistence", () => {
  test("syncs before replacement and after rename, and preserves the primary if file sync fails", async () => {
    const modulePath = fileURLToPath(new URL("../../src/utils/durable-json.ts", import.meta.url));
    for (const failSync of [false, true]) {
      const path = await tempFile();
      await writeFile(path, JSON.stringify({ revision: 1 }));
      // Isolate fault injection so other tests keep using real filesystem APIs.
      const script = `
        import { mock } from "bun:test";
        const fs = { ...await import("node:fs/promises") };
        const path = ${JSON.stringify(path)};
        const events = [];
        mock.module("node:fs/promises", () => ({
          ...fs,
          async open(name, ...args) {
            const file = await fs.open(name, ...args);
            const sync = file.sync.bind(file);
            file.sync = async () => {
              const kind = name === ${JSON.stringify(dirname(path))} ? "directory" : name.startsWith(path + ".bak") ? "backup" : "primary";
              events.push("sync:" + kind);
              if (${failSync} && kind === "primary") throw new Error("injected sync failure");
              await sync();
            };
            return file;
          },
          async rename(from, to) {
            events.push(to === path ? "rename:primary" : "rename:backup");
            return fs.rename(from, to);
          }
        }));
        const { writeDurableJson } = await import(${JSON.stringify(modulePath)});
        let failed = false;
        try { await writeDurableJson(path, { revision: 2 }, value => value); }
        catch (error) { if (error.message !== "injected sync failure") throw error; failed = true; }
        console.log(JSON.stringify({ failed, events }));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const result = JSON.parse(stdout);
      expect(result.failed).toBe(failSync);
      if (failSync) {
        expect(result.events).not.toContain("rename:primary");
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ revision: 1 });
      } else {
        const renameIndex = result.events.indexOf("rename:primary");
        expect(result.events[renameIndex - 1]).toBe("sync:primary");
        expect(result.events[renameIndex + 1]).toBe("sync:directory");
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ revision: 2 });
      }
      expect((await readdir(dirname(path))).some(name => name.endsWith(".tmp"))).toBe(false);
    }
  });

  test("creates nested storage directories", async () => {
    const path = join(await tempFile(), "nested", "accounts.json");
    await writeDurableJson(path, { revision: 1 }, decode);
    expect(await readDurableJson(path, decode)).toEqual({ revision: 1 });
  });
  test("creates private files and keeps two previous valid generations", async () => {
    const path = await tempFile();
    for (const revision of [1, 2, 3]) await writeDurableJson(path, { revision }, decode);
    expect(await readDurableJson(path, decode)).toEqual({ revision: 3 });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual({ revision: 2 });
    expect(JSON.parse(await readFile(`${path}.bak.1`, "utf8"))).toEqual({ revision: 1 });
    for (const file of [path, `${path}.bak`, `${path}.bak.1`]) expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("serializes simultaneous saves and snapshots mutable inputs", async () => {
    const path = await tempFile();
    const input = { revision: 0 };
    const saves = Array.from({ length: 25 }, (_, revision) => {
      input.revision = revision;
      return writeDurableJson(path, input, decode);
    });
    input.revision = 999;
    await Promise.all(saves);
    expect(await readDurableJson(path, decode)).toEqual({ revision: 24 });
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual({ revision: 23 });
    expect((await readdir(dirs[0]!)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("recovers a zero-filled primary from backup and preserves corrupt evidence", async () => {
    const path = await tempFile();
    await writeDurableJson(path, { revision: 1 }, decode);
    await writeFile(path, Buffer.alloc(34791));
    expect(await readDurableJson(path, decode)).toEqual({ revision: 1 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ revision: 1 });
    const archive = (await readdir(dirs[0]!)).find(name => name.includes(".corrupt-"));
    expect(await readFile(join(dirs[0]!, archive!))).toEqual(Buffer.alloc(34791));
  });

  test("falls back to the older generation when the primary and first backup are invalid", async () => {
    const path = await tempFile();
    for (const revision of [1, 2, 3]) await writeDurableJson(path, { revision }, decode);
    await writeFile(path, "{}");
    await writeFile(`${path}.bak`, "broken");
    expect(await readDurableJson(path, decode)).toEqual({ revision: 1 });
  });

  test("recovers a missing primary instead of treating it as a fresh installation", async () => {
    const path = await tempFile();
    expect(await readDurableJson(path, decode)).toBeUndefined();
    await writeDurableJson(path, { revision: 1 }, decode);
    await unlink(path);
    expect(await readDurableJson(path, decode)).toEqual({ revision: 1 });
  });

  test("refuses to replace unrecoverable files with new or empty data", async () => {
    const path = await tempFile();
    await writeFile(path, "corrupt");
    await expect(readDurableJson(path, decode)).rejects.toThrow("refusing to overwrite");
    await expect(writeDurableJson(path, { revision: 1 }, decode)).rejects.toThrow("refusing to overwrite");
    expect(await readFile(path, "utf8")).toBe("corrupt");
  });

  test("failed backup I/O leaves the primary intact and does not poison future saves", async () => {
    const path = await tempFile();
    await writeDurableJson(path, { revision: 1 }, decode);
    await unlink(`${path}.bak`);
    await mkdir(`${path}.bak`);
    await expect(writeDurableJson(path, { revision: 2 }, decode)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ revision: 1 });
    await rm(`${path}.bak`, { recursive: true });
    await writeDurableJson(path, { revision: 3 }, decode);
    expect(await readDurableJson(path, decode)).toEqual({ revision: 3 });
  });

  test("unchanged legacy data gets a backup without replacing the primary", async () => {
    const path = await tempFile();
    await writeFile(path, JSON.stringify({ revision: 1 }, null, 2));
    const before = await stat(path);
    await writeDurableJson(path, { revision: 1 }, decode);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toEqual({ revision: 1 });
  });
});
