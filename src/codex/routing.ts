export interface ModelRoute {
  provider: "codex" | "antigravity";
  upstreamModel: string;
}

export function resolveCodexModel(model: string, configuredModels: string[]): ModelRoute {
  const raw = String(model || "").trim();
  if (raw.toLowerCase().startsWith("codex/")) {
    return { provider: "codex", upstreamModel: raw.slice("codex/".length) };
  }
  const configured = new Set((configuredModels || []).map(item => item.trim().toLowerCase()).filter(Boolean));
  if (configured.has(raw.toLowerCase())) return { provider: "codex", upstreamModel: raw };
  return { provider: "antigravity", upstreamModel: raw };
}
