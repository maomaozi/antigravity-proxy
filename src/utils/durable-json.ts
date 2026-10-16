import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Decoder<T> = (value: unknown) => T;
const pending = new Map<string, Promise<unknown>>();
class InvalidStoredJsonError extends Error {}

function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = pending.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  pending.set(key, next);
  void next.finally(() => {
    if (pending.get(key) === next) pending.delete(key);
  }).catch(() => {});
  return next;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent === path) return;
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code === "EEXIST") return;
    if (error?.code !== "ENOENT") throw error;
    await ensureDirectory(parent);
    await ensureDirectory(path);
    return;
  }
  await syncDirectory(parent);
}

async function replaceDurably(path: string, text: string | Uint8Array): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readRecoverable<T>(path: string, decode: Decoder<T>): Promise<{ text: string; value: T } | undefined> {
  let found = false;
  const primary = await readOptional(path);
  for (const candidate of [path, `${path}.bak`, `${path}.bak.1`]) {
    const text = candidate === path ? primary : await readOptional(candidate);
    if (text === undefined) continue;
    found = true;
    let value: T;
    try {
      value = decode(JSON.parse(text));
    } catch {
      continue;
    }
    if (candidate !== path) {
      if (primary !== undefined) await replaceDurably(`${path}.corrupt-${Date.now()}-${randomUUID()}`, await readFile(path));
      await replaceDurably(path, text);
      console.warn(`[Storage] Recovered ${path} from ${candidate}.`);
    }
    return { text, value };
  }
  if (found) throw new InvalidStoredJsonError(`[Storage] ${path} and its backups are invalid; refusing to overwrite stored data.`);
  return undefined;
}

export function readDurableJson<T>(path: string, decode: Decoder<T>): Promise<T | undefined> {
  return serialized(path, async () => (await readRecoverable(path, decode))?.value);
}

export function writeDurableJson<T>(path: string, value: T, decode: Decoder<T>, options: { resetCorrupt?: boolean } = {}): Promise<void> {
  // Snapshot mutable account arrays before waiting for earlier saves.
  const text = JSON.stringify(value, null, 2);
  decode(JSON.parse(text));
  return serialized(path, async () => {
    let previous;
    try {
      previous = await readRecoverable(path, decode);
    } catch (error) {
      if (!(error instanceof InvalidStoredJsonError) || !options.resetCorrupt) throw error;
      const corrupt = await readOptional(path);
      if (corrupt !== undefined) await replaceDurably(`${path}.corrupt-${Date.now()}-${randomUUID()}`, await readFile(path));
      console.warn(`[Storage] Resetting corrupt disposable state: ${path}.`);
    }
    if (previous?.text === text) {
      const backup = await readOptional(`${path}.bak`);
      let valid = false;
      if (backup !== undefined) try { decode(JSON.parse(backup)); valid = true; } catch {}
      if (!valid) await replaceDurably(`${path}.bak`, text);
      return;
    }
    if (previous) {
      const backup = await readOptional(`${path}.bak`);
      if (backup !== undefined) {
        let valid = false;
        try { decode(JSON.parse(backup)); valid = true; } catch {}
        if (valid) await replaceDurably(`${path}.bak.1`, backup);
      }
      await replaceDurably(`${path}.bak`, previous.text);
    } else {
      // The first successful save already has a recoverable copy.
      await replaceDurably(`${path}.bak`, text);
    }
    await replaceDurably(path, text);
  });
}
