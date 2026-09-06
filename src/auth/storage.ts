import { join } from "path";
import { rename } from "fs/promises";
import { type AntigravityAccount } from "./types";

const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || join(process.cwd(), "antigravity-accounts.json");

interface StorageFormat {
    accounts: AntigravityAccount[];
}

export async function loadConfig(): Promise<StorageFormat> {
  try {
    const file = Bun.file(ACCOUNTS_FILE);
    if (await file.exists()) {
      const data = await file.json();
      if (Array.isArray(data)) {
          // Migration from old format
          return { accounts: data };
      }
      return { accounts: Array.isArray(data?.accounts) ? data.accounts : [] };
    }
  } catch (e) {
    console.error("Failed to load accounts:", e);
  }
  return { accounts: [] };
}

// Kept for backward compatibility but deprecated
export async function saveConfig(config: StorageFormat): Promise<void> {
  try {
    const tmpPath = `${ACCOUNTS_FILE}.${process.pid}.${Date.now()}.tmp`;
    await Bun.write(tmpPath, JSON.stringify(config, null, 2));
    await rename(tmpPath, ACCOUNTS_FILE);
  } catch (e) {
    console.error("Failed to save accounts:", e);
  }
}
