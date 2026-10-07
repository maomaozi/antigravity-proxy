import { describe, expect, test } from "bun:test";
import { handleImageGeneration, imageGenerationEndpoints, type ImageGenerationRuntime } from "../../src/api/openai/images";
import type { AntigravityAccount } from "../../src/auth/types";

function account(name: string): AntigravityAccount {
  return { email: `${name}@example.com`, accessToken: `access-${name}`, refreshToken: `refresh-${name}`, expiresAt: Date.now() + 3600000, projectId: `project-${name}`, healthScore: 100, lastUsed: 0, tokenUsage: 0 };
}
function request(body: unknown, signal?: AbortSignal) {
  return new Request("http://localhost/v1/images/generations", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal });
}
function success(mime = "image/jpeg") {
  return Response.json({ response: { modelVersion: "actual-upstream-version", candidates: [{ content: { parts: [
    { thought: true, inlineData: { mimeType: "image/png", data: "dGhvdWdodA==" } },
    { text: "Generated image" },
    { inlineData: { mimeType: mime, data: "aW1hZ2U=" } },
  ] } }] } });
}
const png = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a00000000", "hex").toString("base64")}`;
const jpeg = `data:image/jpeg;base64,${Buffer.from("ffd8ff00", "hex").toString("base64")}`;
function fixture() {
  const accounts = [account("a"), account("b"), account("c")];
  const calls: Array<{ url: string; headers: Headers; body: any }> = [];
  const prepared: Array<{ email: string; forceRefresh: boolean }> = [];
  const usage: string[] = [];
  const runtime: ImageGenerationRuntime = {
    getAccounts: () => accounts,
    prepareAccount: async (email, forceRefresh = false) => {
      prepared.push({ email, forceRefresh });
      return accounts.find(a => a.email === email) || null;
    },
    getEndpoints: () => ["https://first.googleapis.com/v1internal:streamGenerateContent?alt=sse", "https://second.googleapis.com/v1internal:streamGenerateContent?alt=sse"],
    getTimeoutMs: () => 5000,
    randomIndex: () => 1,
    fetch: (async (url, options) => {
      calls.push({ url: String(url), headers: new Headers(options?.headers), body: JSON.parse(String(options?.body)) });
      return success();
    }) as ImageGenerationRuntime["fetch"],
    onSuccess: async a => { usage.push(a.email); },
  };
  return { runtime, accounts, calls, prepared, usage };
}

describe("Images API", () => {
  test("sends text and multiple reference images to the existing upstream endpoint in order", async () => {
    const f = fixture();
    const response = await handleImageGeneration(request({ model: "gemini-3.1-flash-image", prompt: "Make the sky orange", images: [png, jpeg] }), f.runtime);
    expect(response.status).toBe(200);
    expect(f.calls[0]!.body.request.contents).toEqual([{ role: "user", parts: [
      { text: "Make the sky orange" },
      { inlineData: { mimeType: "image/png", data: png.split(",")[1] } },
      { inlineData: { mimeType: "image/jpeg", data: jpeg.split(",")[1] } },
    ] }]);
    expect(await response.json()).toMatchObject({ data: [{ b64_json: "aW1hZ2U=" }] });
  });

  test("rejects malformed reference images before selecting an account", async () => {
    const invalid = [[], Array(9).fill(png), ["https://example.com/photo.png"], ["data:image/png;base64,AQID"], ["data:image/png;base64,////"], ["data:image/png;base64,%%%"], [`data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64")}`]];
    for (const images of invalid) {
      const f = fixture();
      const response = await handleImageGeneration(request({ model: "x", prompt: "edit", images }), f.runtime);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { param: "images" } });
      expect(f.prepared).toHaveLength(0);
    }
  });

  test("passes an arbitrary mixed-case model unchanged and returns real image parts only", async () => {
    const f = fixture();
    const response = await handleImageGeneration(request({ model: "custom/Future-Image-9.1", prompt: "a cat", image_size: "4K", aspect_ratio: "16:9", thinking_level: "high" }), f.runtime);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Antigravity-Attempts")).toBe("1");
    expect(f.prepared).toEqual([{ email: "b@example.com", forceRefresh: false }]);
    expect(f.calls[0]!.url).toBe("https://first.googleapis.com/v1internal:generateContent");
    expect(f.calls[0]!.headers.get("Authorization")).toBe("Bearer access-b");
    expect(f.calls[0]!.body).toMatchObject({ model: "custom/Future-Image-9.1", project: "project-b", requestType: "image_gen", request: {
      contents: [{ role: "user", parts: [{ text: "a cat" }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { imageSize: "4K", aspectRatio: "16:9" }, thinkingConfig: { thinkingLevel: "high", includeThoughts: false } },
    } });
    expect(await response.json()).toMatchObject({ model: "custom/Future-Image-9.1", model_version: "actual-upstream-version", data: [{ b64_json: "aW1hZ2U=", mime_type: "image/jpeg" }] });
    expect(f.usage).toEqual(["b@example.com"]);
  });

  test("random selection is repeated per request and ignores session affinity", async () => {
    const f = fixture();
    const choices = [2, 0];
    f.runtime.randomIndex = () => choices.shift()!;
    for (let i = 0; i < 2; i++) {
      const req = request({ model: "future-model", prompt: "a cat", prompt_cache_key: "same-session" });
      req.headers.set("thread-id", "same-thread");
      expect((await handleImageGeneration(req, f.runtime)).status).toBe(200);
    }
    expect(f.prepared.map(p => p.email)).toEqual(["c@example.com", "a@example.com"]);
  });

  test("excludes challenged accounts and skips failed preparation", async () => {
    const f = fixture();
    f.accounts[0]!.challenge = { type: "captcha", url: "https://google.com", detectedAt: Date.now() };
    const lengths: number[] = [];
    f.runtime.randomIndex = length => { lengths.push(length); return 0; };
    f.runtime.prepareAccount = async email => email === "b@example.com" ? null : f.accounts[2]!;
    expect((await handleImageGeneration(request({ model: "x", prompt: "y" }), f.runtime)).status).toBe(200);
    expect(lengths).toEqual([2, 1]);
    expect(f.calls[0]!.headers.get("Authorization")).toBe("Bearer access-c");
  });

  test.each(["512", "1K", "2K", "4K"])("forwards %s without model-specific restrictions", async size => {
    const f = fixture();
    expect((await handleImageGeneration(request({ model: "any-model", prompt: "x", image_size: size }), f.runtime)).status).toBe(200);
    expect(f.calls[0]!.body.request.generationConfig.imageConfig.imageSize).toBe(size);
  });

  test("maps square OpenAI sizes and omits unspecified thinking", async () => {
    const f = fixture();
    await handleImageGeneration(request({ model: "x", prompt: "y", size: "2048x2048" }), f.runtime);
    expect(f.calls[0]!.body.request.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "2K" } });
  });

  test("rejects invalid input before selecting an account or calling upstream", async () => {
    const f = fixture();
    const invalid = [null, [], {}, { model: " ", prompt: "x" }, { model: "x", prompt: 7 },
      { model: "x", prompt: "y", n: 2 }, { model: "x", prompt: "y", response_format: "url" },
      { model: "x", prompt: "y", image_size: "8K" }, { model: "x", prompt: "y", aspect_ratio: "bad" },
      { model: "x", prompt: "y", image_size: "1K", size: "2048x2048" },
      { model: "x", prompt: "y", size: "1024x1024", aspect_ratio: "16:9" },
      { model: "x", prompt: "y", stream: true }, { model: "x", prompt: "y", thinking_level: "unlimited" }];
    for (const body of invalid) expect((await handleImageGeneration(request(body), f.runtime)).status).toBe(400);
    const malformed = new Request("http://localhost", { method: "POST", body: "{" });
    expect((await handleImageGeneration(malformed, f.runtime)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
    expect(f.prepared).toHaveLength(0);
  });

  test("falls back across endpoints on 404/429 using the same account and model", async () => {
    const f = fixture();
    const capture = f.runtime.fetch;
    f.runtime.fetch = (async (...args) => {
      await capture(...args);
      return f.calls.length === 1 ? Response.json({ error: { message: "Not found", status: "NOT_FOUND" } }, { status: 404 }) : success();
    }) as ImageGenerationRuntime["fetch"];
    const response = await handleImageGeneration(request({ model: "unknown-experimental", prompt: "x" }), f.runtime);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Antigravity-Attempts")).toBe("2");
    expect(f.prepared).toHaveLength(1);
    expect(f.calls.map(c => c.headers.get("Authorization"))).toEqual(["Bearer access-b", "Bearer access-b"]);
    expect(f.calls.map(c => c.body.model)).toEqual(["unknown-experimental", "unknown-experimental"]);
  });

  test("preserves unavailable-model errors and does not switch accounts", async () => {
    const f = fixture();
    f.runtime.fetch = (async () => Response.json({ error: { message: "Requested entity was not found.", status: "NOT_FOUND" } }, { status: 404 })) as ImageGenerationRuntime["fetch"];
    const response = await handleImageGeneration(request({ model: "unknown", prompt: "x" }), f.runtime);
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Antigravity-Attempts")).toBe("2");
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "Requested entity was not found." } });
    expect(f.prepared).toHaveLength(1);
    expect(f.usage).toHaveLength(0);
  });

  test("refreshes a 401 once on the same account and retries the same endpoint", async () => {
    const f = fixture();
    const prepare = f.runtime.prepareAccount;
    f.runtime.prepareAccount = async (email, refresh) => {
      const ready = await prepare(email, refresh);
      if (refresh && ready) ready.accessToken = "new-access";
      return ready;
    };
    const capture = f.runtime.fetch;
    f.runtime.fetch = (async (...args) => {
      await capture(...args);
      return f.calls.length === 1 ? new Response("Expired", { status: 401 }) : success();
    }) as ImageGenerationRuntime["fetch"];
    const response = await handleImageGeneration(request({ model: "x", prompt: "y" }), f.runtime);
    expect(response.status).toBe(200);
    expect(f.prepared).toEqual([{ email: "b@example.com", forceRefresh: false }, { email: "b@example.com", forceRefresh: true }]);
    expect(f.calls.map(c => c.url)).toEqual([f.calls[0]!.url, f.calls[0]!.url]);
    expect(f.calls[1]!.headers.get("Authorization")).toBe("Bearer new-access");
  });

  test("does not loop on repeated 401s", async () => {
    const f = fixture();
    let calls = 0;
    f.runtime.fetch = (async () => { calls++; return new Response("Expired", { status: 401 }); }) as ImageGenerationRuntime["fetch"];
    expect((await handleImageGeneration(request({ model: "x", prompt: "y" }), f.runtime)).status).toBe(401);
    expect(calls).toBe(2);
  });

  test("reports no-image responses without repeating a successful upstream call", async () => {
    const f = fixture();
    let calls = 0;
    f.runtime.fetch = (async () => { calls++; return Response.json({ candidates: [{ content: { parts: [{ text: "No image" }] }, finishReason: "SAFETY" }] }); }) as ImageGenerationRuntime["fetch"];
    const response = await handleImageGeneration(request({ model: "text-only-model", prompt: "x" }), f.runtime);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "no_image" } });
    expect(calls).toBe(1);
  });

  test("returns 503 when no accounts are ready", async () => {
    const f = fixture();
    f.runtime.getAccounts = () => [];
    expect((await handleImageGeneration(request({ model: "x", prompt: "y" }), f.runtime)).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });

  test("cancels upstream when generation times out", async () => {
    const f = fixture();
    f.runtime.getTimeoutMs = () => 10;
    f.runtime.fetch = ((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    })) as ImageGenerationRuntime["fetch"];
    const response = await handleImageGeneration(request({ model: "x", prompt: "y" }), f.runtime);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "timeout" } });
  });

  test("does not select an account for an already cancelled request", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect((await handleImageGeneration(request({ model: "x", prompt: "y" }, controller.signal), f.runtime)).status).toBe(499);
    expect(f.prepared).toHaveLength(0);
  });

  test("converts configured stream endpoints and deduplicates them", () => {
    expect(imageGenerationEndpoints(["https://host/v1internal:streamGenerateContent?alt=sse", "https://host/v1internal:generateContent"])).toEqual(["https://host/v1internal:generateContent"]);
  });
});
