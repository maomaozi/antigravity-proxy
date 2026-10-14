import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { refreshAccessToken } from "../src/auth/oauth";
import { generateFingerprint, getImpersonationHeaders } from "../src/utils/headers";
import type { AntigravityAccount } from "../src/auth/types";

// Live, account-pinned image test. Credentials remain in memory; reports contain
// only response metadata and generated images, never OAuth tokens.
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name}`);
  return args[index + 1]!;
}
const model = option("--model", "gemini-nano-banana-2.1");
const output = resolve(option("--output", `data/nano-banana-test-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const email = option("--email", "");
const prompt = option("--prompt", "Generate one square image: a small orange cat astronaut holding a yellow banana on the Moon, Earth in the background, charming detailed editorial illustration. Include a clear small sign reading BANANA TEST. No extra images.");
const file = await Bun.file("antigravity-accounts.json").json();
const accounts: AntigravityAccount[] = (Array.isArray(file) ? file : file.accounts).filter((a: AntigravityAccount) => !email || a.email === email);
if (!accounts.length) throw new Error("No matching Google OAuth accounts");
await mkdir(output, { recursive: true, mode: 0o700 });
const report: any = { startedAt: new Date().toISOString(), model, prompt, imageConfig: { aspectRatio: "1:1", imageSize: "1K" }, accounts: [] };
async function checkpoint() {
  await Bun.write(`${output}/report.json`, JSON.stringify(report, null, 2));
}
function redact(value: unknown, account: AntigravityAccount) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of [account.accessToken, account.refreshToken]) if (secret) text = text.replaceAll(secret, "[REDACTED]");
  return text.slice(0, 1600);
}
async function post(host: string, method: string, body: unknown, account: AntigravityAccount, timeout = 30000) {
  return fetch(`https://${host}/v1internal:${method}`, {
    method: "POST",
    headers: getImpersonationHeaders(account.accessToken!, account.fingerprint, model),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
}
for (const [index, original] of accounts.entries()) {
  const account = structuredClone(original);
  const row: any = { email: account.email, project: account.projectId, attempts: [], images: [] };
  report.accounts.push(row);
  console.log(`[${index + 1}/${accounts.length}] ${account.email}`);
  try {
    if (!account.accessToken || (account.expiresAt || 0) <= Date.now() + 60000) {
      const token = await refreshAccessToken(account.refreshToken);
      account.accessToken = token.access_token;
      account.expiresAt = Date.now() + token.expires_in * 1000;
      row.oauthRefreshed = true;
    }
    account.fingerprint ||= generateFingerprint(account.email);
    const discovery = await post("daily-cloudcode-pa.googleapis.com", "fetchAvailableModels", { project: account.projectId }, account);
    row.discoveryStatus = discovery.status;
    const discoveryText = await discovery.text();
    if (discovery.ok) {
      const data = JSON.parse(discoveryText);
      const models = data.models || data.availableModels || {};
      row.availableModels = Array.isArray(models) ? models.map((m: any) => ({ id: m.model?.name || m.name, displayName: m.displayName, quotaInfo: m.quotaInfo })) : Object.entries(models).map(([id, m]: [string, any]) => ({ id, displayName: m.displayName || m.displayMetadata?.label, quotaInfo: m.quotaInfo }));
      row.discoveryMetadata = Object.fromEntries(Object.entries(data).filter(([key]) => !["models", "availableModels"].includes(key)));
      console.log(`  discovery=${discovery.status} image models=${JSON.stringify(row.availableModels.filter((m: any) => /image|banana/i.test(m.id + " " + m.displayName)))}`);
    } else row.discoveryError = redact(discoveryText, account);
    const tierResponse = await post("cloudcode-pa.googleapis.com", "loadCodeAssist", { metadata: { ideType: "VSCODE", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }, account);
    row.tierStatus = tierResponse.status;
    if (tierResponse.ok) {
      const tier = await tierResponse.json() as any;
      row.tier = tier.currentTier || tier.paidTier;
      row.discoveredProject = tier.cloudaicompanionProject;
    }
    await checkpoint();
    if (args.includes("--probe-only")) continue;
    if (!account.projectId) throw new Error("Account has no project ID");
    for (const host of ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]) {
      const body = {
        project: account.projectId,
        model,
        userAgent: "antigravity",
        requestType: "image_gen",
        requestId: `img-${crypto.randomUUID()}`,
        request: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: report.imageConfig },
        },
      };
      const started = Date.now();
      const attempt: any = { host, method: "generateContent", requestType: body.requestType };
      row.attempts.push(attempt);
      try {
        const response = await post(host, "generateContent", body, account, 180000);
        attempt.status = response.status;
        const text = await response.text();
        attempt.elapsedMs = Date.now() - started;
        if (!response.ok) {
          attempt.error = redact(text, account);
          console.log(`  ${host} HTTP ${response.status}: ${attempt.error.slice(0, 550)}`);
          await checkpoint();
          continue;
        }
        const data = JSON.parse(text);
        const result = data.response || data;
        attempt.modelVersion = result.modelVersion;
        attempt.usageMetadata = result.usageMetadata;
        attempt.promptFeedback = result.promptFeedback;
        attempt.candidates = (result.candidates || []).map((candidate: any) => ({ finishReason: candidate.finishReason, text: (candidate.content?.parts || []).filter((p: any) => p.text && !p.thought).map((p: any) => p.text).join("\n") }));
        for (const candidate of result.candidates || []) {
          for (const part of candidate.content?.parts || []) {
            const inline = part.inlineData || part.inline_data;
            if (!inline?.data || part.thought) continue;
            const mime = inline.mimeType || inline.mime_type;
            if (!mime?.startsWith("image/")) continue;
            const bytes = Buffer.from(inline.data, "base64");
            const extension = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
            const name = `${account.email.replace(/[^a-zA-Z0-9_-]/g, "_")}-${row.images.length + 1}.${extension}`;
            await Bun.write(`${output}/${name}`, bytes);
            row.images.push({ file: name, mimeType: mime, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
          }
        }
        console.log(`  ${host} HTTP ${response.status}, images=${row.images.length}, ${attempt.elapsedMs}ms`);
        await checkpoint();
        if (row.images.length) break;
      } catch (error) {
        attempt.elapsedMs = Date.now() - started;
        attempt.error = redact(String(error), account);
        console.log(`  ${host}: ${attempt.error}`);
        await checkpoint();
      }
    }
  } catch (error) {
    row.error = redact(String(error), account);
    console.log(`  ERROR ${row.error}`);
  }
  await checkpoint();
}
report.finishedAt = new Date().toISOString();
report.successfulAccounts = report.accounts.filter((a: any) => a.images.length).length;
await checkpoint();
console.log(`Saved ${output}/report.json; ${report.successfulAccounts}/${accounts.length} accounts returned images`);
if (!args.includes("--probe-only") && report.successfulAccounts !== accounts.length) process.exitCode = 1;
