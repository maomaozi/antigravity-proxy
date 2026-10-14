import { mkdir, writeFile } from "node:fs/promises";
import { refreshAccessToken } from "../src/auth/oauth";
import type { AntigravityAccount } from "../src/auth/types";
import { generateFingerprint, getImpersonationHeaders } from "../src/utils/headers";

// Read-only discovery: refresh tokens in memory and leave proxy account/config files untouched.
const manifestUrl = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const endpoint = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const startedAt = new Date().toISOString();
const output = process.argv[2] || `data/antigravity-models-${startedAt.replace(/[:.]/g, "-")}`;
await mkdir(output, { recursive: true, mode: 0o700 });
const manifestResponse = await fetch(manifestUrl, {
  headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
  signal: AbortSignal.timeout(25_000),
});
if (!manifestResponse.ok) throw new Error(`Manifest HTTP ${manifestResponse.status}`);
const manifest = await manifestResponse.text();
const version = manifest.match(/^version:\s*["']?([\d.]+)/m)?.[1];
if (!version) throw new Error("Manifest has no version");
const userAgent = `antigravity/hub/${version} darwin/arm64`;
await writeFile(`${output}/latest-arm64-mac.yml`, manifest, { mode: 0o600 });
const stored = await Bun.file("antigravity-accounts.json").json();
const accounts: AntigravityAccount[] = structuredClone(stored.accounts || stored);
const secrets = accounts.flatMap(account => [account.accessToken, account.refreshToken]).filter((value): value is string => Boolean(value));
function redact(value: string): string {
  for (const secret of secrets) value = value.replaceAll(secret, "[REDACTED]");
  return value;
}
const catalogs = await Promise.all(accounts.map(async (account, index) => {
  const started = Date.now();
  try {
    async function refresh() {
      const token = await refreshAccessToken(account.refreshToken);
      account.accessToken = token.access_token;
      secrets.push(token.access_token);
    }
    if (!account.accessToken || (account.expiresAt || 0) < Date.now() + 60_000) await refresh();
    account.fingerprint ||= generateFingerprint(account.email);
    if (!account.projectId) throw new Error("Missing projectId");
    async function send() {
      return fetch(endpoint, {
        method: "POST",
        headers: { ...getImpersonationHeaders(account.accessToken!, account.fingerprint), "User-Agent": userAgent },
        body: JSON.stringify({ project: account.projectId }),
        signal: AbortSignal.timeout(25_000),
      });
    }
    let response = await send();
    if (response.status === 401) {
      await response.text();
      await refresh();
      response = await send();
    }
    const raw = redact(await response.text());
    const data = JSON.parse(raw);
    const models = data.models || data.availableModels || {};
    const entries: [string, any][] = Array.isArray(models)
      ? models.map((model: any) => [model.name || model.model?.name || model.id, model])
      : Object.entries(models);
    const rows = entries.map(([id, model]: [string, any]) => ({
      id, displayName: model.displayName || model.displayMetadata?.label || "",
      model: model.model, quotaInfo: model.quotaInfo,
    })).sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    const result = { account: index + 1, email: account.email, status: response.status, elapsedMs: Date.now() - started, models: rows, data };
    console.log(JSON.stringify({ account: index + 1, status: response.status, count: rows.length }));
    return result;
  } catch (error) {
    return { account: index + 1, email: account.email, elapsedMs: Date.now() - started, error: redact(String(error)) };
  }
}));
const report = { startedAt, finishedAt: new Date().toISOString(), manifestUrl, version, userAgent, endpoint, catalogs };
await writeFile(`${output}/audit.json`, redact(JSON.stringify(report, null, 2)), { mode: 0o600 });
console.log(JSON.stringify({ version, userAgent, report: `${output}/audit.json`, succeeded: catalogs.filter(result => "status" in result && result.status === 200).length, total: accounts.length }));
if (catalogs.some(result => !("status" in result) || result.status !== 200)) process.exitCode = 1;
