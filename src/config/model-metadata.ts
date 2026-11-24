function isUpstreamModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(value) && !value.startsWith('antigravity-');
}

/** Validate configurable model metadata without overriding account eligibility. */
export function validateModelMetadataOverrides(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('models.overrides must be an object');
  for (const [id, rule] of Object.entries(value)) {
    const path = `models.overrides.${id}`;
    if (!isUpstreamModelId(id)) throw new Error(`${path} must use a normalized upstream model ID`);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${path} must be an object`);
    if (Object.keys(rule).some(key => !['name', 'quotaPool', 'fallbackQuotaPool', 'fallbackModelId', 'thinkingLevels', 'defaultThinkingLevel'].includes(key))) throw new Error(`${path} contains an unsupported metadata field`);
    const { name, quotaPool, fallbackQuotaPool, fallbackModelId, thinkingLevels, defaultThinkingLevel } = rule as Record<string, unknown>;
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new Error(`${path}.name must be a non-empty string`);
    if (quotaPool !== undefined && (typeof quotaPool !== 'string' || !quotaPool.trim())) throw new Error(`${path}.quotaPool must be a non-empty string`);
    if (fallbackQuotaPool !== undefined && (typeof fallbackQuotaPool !== 'string' || !fallbackQuotaPool.trim())) throw new Error(`${path}.fallbackQuotaPool must be a non-empty string`);
    if (fallbackModelId !== undefined && (!isUpstreamModelId(fallbackModelId) || fallbackModelId === id)) throw new Error(`${path}.fallbackModelId must be a different normalized upstream model ID`);
    if (thinkingLevels !== undefined) {
      if (!Array.isArray(thinkingLevels) || !thinkingLevels.length || thinkingLevels.some(level => typeof level !== 'string' || !['minimal', 'low', 'medium', 'high', 'xhigh', 'thinking'].includes(level)) || new Set(thinkingLevels).size !== thinkingLevels.length) {
        throw new Error(`${path}.thinkingLevels must contain distinct supported thinking levels`);
      }
    }
    if (defaultThinkingLevel !== undefined && (typeof defaultThinkingLevel !== 'string' || !Array.isArray(thinkingLevels) || !thinkingLevels.includes(defaultThinkingLevel))) {
      throw new Error(`${path}.defaultThinkingLevel must belong to thinkingLevels`);
    }
  }
}
