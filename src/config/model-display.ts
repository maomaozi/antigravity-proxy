/** Validate partial display settings before storing or serving them. */
export function validateModelDisplayConfig(value: unknown): void {
  function object(value: unknown, path: string): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    return value as Record<string, any>;
  }
  function strings(value: unknown, path: string, patterns = false): void {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${path} must be an array of non-empty strings`);
    if (patterns) for (const pattern of value) {
      try { new RegExp(pattern, 'i'); } catch { throw new Error(`${path} contains an invalid regular expression: ${pattern}`); }
    }
  }
  const config = object(value, 'display');
  if (config.visibility !== undefined) {
    const visibility = object(config.visibility, 'display.visibility');
    for (const key of ['showPatterns', 'hidePatterns']) if (visibility[key] !== undefined) strings(visibility[key], `display.visibility.${key}`, true);
  }
  if (config.groupOrder !== undefined) strings(config.groupOrder, 'display.groupOrder');
  for (const key of ['groups', 'poolRules']) {
    if (config[key] === undefined) continue;
    if (!Array.isArray(config[key])) throw new Error(`display.${key} must be an array`);
    for (const [index, value] of config[key].entries()) {
      const path = `display.${key}[${index}]`;
      const rule = object(value, path);
      strings(rule.patterns, `${path}.patterns`, true);
      if (!rule.patterns.length) throw new Error(`${path}.patterns cannot be empty`);
      if (key === 'groups') {
        if (typeof rule.name !== 'string' || !rule.name.trim()) throw new Error(`${path}.name must be a non-empty string`);
        if (rule.separateWhen !== undefined && !['always', 'different-accounts'].includes(rule.separateWhen)) throw new Error(`${path}.separateWhen must be always or different-accounts`);
      } else {
        strings(rule.pools, `${path}.pools`);
        if (!rule.pools.length) throw new Error(`${path}.pools cannot be empty`);
        if (rule.preferDeclaredPool !== undefined && typeof rule.preferDeclaredPool !== 'boolean') throw new Error(`${path}.preferDeclaredPool must be a boolean`);
      }
    }
  }
}
