import { mkdir } from "node:fs/promises";
import { refreshAccessToken } from "../src/auth/oauth";
import { generateFingerprint, getImpersonationHeaders } from "../src/utils/headers";
import type { AntigravityAccount } from "../src/auth/types";

// Audit raw catalogs and upstream IDs without proxy aliases or account rotation.
const output = process.argv[2] || `data/nano-banana-audit-${Date.now()}`;
await mkdir(output, { recursive: true, mode: 0o700 });
const loaded = await Bun.file("antigravity-accounts.json").json();
const allAccounts: AntigravityAccount[] = structuredClone(loaded.accounts || loaded);
const accounts = process.argv.includes("--first-account") ? allAccounts.slice(0, 1) : allAccounts;
const userAgentIndex = process.argv.indexOf("--user-agent");
const userAgent = userAgentIndex < 0 ? undefined : process.argv[userAgentIndex + 1];
if (userAgentIndex >= 0 && (!userAgent || userAgent.startsWith("--"))) throw new Error("Missing --user-agent value");
const hosts = ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.sandbox.googleapis.com", "autopush-cloudcode-pa.sandbox.googleapis.com"];
const report: any = { startedAt: new Date().toISOString(), userAgentOverride: userAgent, catalogs: [], publicCatalogs: [], generations: [] };
let pendingSave = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(report, null, 2);
  pendingSave = pendingSave.then(async () => { await Bun.write(`${output}/audit.json`, snapshot); });
  return pendingSave;
}
function redact(text: string) {
  for (const a of accounts) for (const secret of [a.accessToken, a.refreshToken]) if (secret) text = text.replaceAll(secret, "[REDACTED]");
  return text;
}
async function call(account: AntigravityAccount, url: string, body?: any, timeout = 20000) {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...getImpersonationHeaders(account.accessToken!, account.fingerprint), ...(userAgent ? { "User-Agent": userAgent } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = redact(await response.text());
    let data: any;
    try { data = JSON.parse(text); } catch { data = text.slice(0, 2000); }
    return { url, status: response.status, elapsedMs: Date.now() - start, data };
  } catch (error) { return { url, elapsedMs: Date.now() - start, error: redact(String(error)) }; }
}
for (const account of accounts) {
  if (!account.accessToken || (account.expiresAt || 0) < Date.now() + 60000) {
    const token = await refreshAccessToken(account.refreshToken);
    account.accessToken = token.access_token;
    account.expiresAt = Date.now() + token.expires_in * 1000;
  }
  account.fingerprint ||= generateFingerprint(account.email);
  const catalogs = await Promise.all(hosts.map(async host => {
    const result = await call(account, `https://${host}/v1internal:fetchAvailableModels`, { project: account.projectId });
    const data = result.data;
    const rows = Object.entries(data?.models || data?.availableModels || {});
    const images = rows.filter(([id, m]: [string, any]) => /image|banana/i.test(id + " " + (m.displayName || m.displayMetadata?.label || "")));
    console.log(`catalog ${account.email} ${host} ${result.status || result.error} images=${images.map(([id]) => id).join(",")}`);
    return { email: account.email, ...result };
  }));
  report.catalogs.push(...catalogs);
  await save();
}
const first = accounts[0]!;
for (const url of ["https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", "https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1"]) {
  const result = await call(first, url);
  report.publicCatalogs.push(result);
  console.log(`public catalog ${result.status || result.error}`);
  await save();
}
const candidates = [
  "gemeni-3.5-image", "gemini-3.5-image", "gemini-3.5-flash-image",
  "gemini-3.6-image", "gemini-3.6-flash-image", "gemini-nano-banana-2.1",
  "nano-banana-2.1", "nano-banana-2", "gemini-3.1-flash-image-preview", "gemini-3-pro-image",
  "gemini-3-flash-image", "gemini-3.1-pro-image", "gemini-3.1-flash-image",
];
async function generate(account: AntigravityAccount, host: string, model: string, imageSize = "1K", thinkingLevel?: string) {
  const body = {
    project: account.projectId, model, userAgent: "antigravity", requestType: "image_gen", requestId: `img-${crypto.randomUUID()}`,
    request: {
      contents: [{ role: "user", parts: [{ text: "Generate one square illustration of an orange cat astronaut holding a banana on the Moon. A clear sign says BANANA TEST." }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize },
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel, includeThoughts: false } } : {}),
      },
    },
  };
  const result = await call(account, `https://${host}/v1internal:generateContent`, body, 120000);
  const row: any = { email: account.email, host, model, generationConfig: body.request.generationConfig, ...result, images: [] };
  if (result.status === 200) {
    const data = result.data?.response || result.data;
    row.modelVersion = data?.modelVersion;
    for (const candidate of data?.candidates || []) for (const part of candidate.content?.parts || []) {
      const inline = part.inlineData || part.inline_data;
      if (inline?.data) {
        const bytes = Buffer.from(inline.data, "base64");
        if (!part.thought && /image\//.test(inline.mimeType || inline.mime_type)) {
          const extension = (inline.mimeType || inline.mime_type) === "image/jpeg" ? "jpg" : (inline.mimeType || inline.mime_type).split("/")[1];
          const name = `${account.email.split("@")[0]}-${host}-${model}-${imageSize}-${thinkingLevel || "default"}-${row.images.length + 1}.${extension}`;
          await Bun.write(`${output}/${name}`, bytes);
          row.images.push({ file: name, bytes: bytes.length, mimeType: inline.mimeType || inline.mime_type, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
        }
        inline.data = `[${bytes.length} decoded bytes omitted]`;
      }
      for (const key of ["thoughtSignature", "thought_signature"]) if (part[key]) part[key] = "[signature omitted]";
    }
  }
  report.generations.push(row);
  console.log(`generate ${account.email} ${host} ${model} size=${imageSize} thinking=${thinkingLevel || "default"}: ${row.status || row.error}; modelVersion=${row.modelVersion || ""}; images=${row.images.length}; ${JSON.stringify(result.data?.error || {}).slice(0, 260)}`);
  await save();
  return row;
}
// Test the suggested names verbatim; do not rewrite unknown IDs to a working model.
for (const model of candidates) {
  await Promise.all(hosts.map(host => generate(first, host, model)));
}
// A behavioral distinction documented by Google: 3.1 supports 512 output,
// whereas 2.1 supports only 1K/2K/4K. Check all five accounts.
for (const account of accounts) await generate(account, hosts[0]!, "gemini-3.1-flash-image", "512");
// 2.1 additionally documents medium thinking; 3.1 lists minimal/high.
await generate(first, hosts[0]!, "gemini-3.1-flash-image", "1K", "medium");
report.finishedAt = new Date().toISOString();
await save();
console.log(`Saved ${output}/audit.json`);
