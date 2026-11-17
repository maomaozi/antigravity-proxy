import { describe, expect, test } from 'bun:test';
import { fetchQuota } from '../../src/api/quota';
import { accountSupportsModel, findAccountModel, getAccountModelPool, getAvailableModelCatalog, getModelReasoningError } from '../../src/models';
import { getAccounts, getBestAccount } from '../../src/auth/manager';
import { transformCompletionToGoogleBody, validateCompletionRequestForGoogle } from '../../src/utils/transform';
import { adaptChatCompletionRequest } from '../../src/api/openai/chat';
import { adaptResponsesRequest } from '../../src/api/openai/responses';
import { getProxyConfig } from '../../src/config/manager';
import { validateModelMetadataOverrides } from '../../src/config/model-metadata';
import type { AntigravityAccount } from '../../src/auth/types';

const id = 'gemini-4-hydrogen-sonar';
async function discoverSonar() {
  const account: AntigravityAccount = { email: 'sonar@example.com', refreshToken: 'refresh', accessToken: 'access', projectId: 'project', expiresAt: Date.now() + 3600000, healthScore: 100, lastUsed: 0, tokenUsage: 0 };
  account.quota = (await fetchQuota(account, false, (async () => Response.json({ models: {
    [id]: { supportsThinking: true, model: 'MODEL_PLACEHOLDER_M578', thinkingLevel: 1, maxOutputTokens: 65536, quotaInfo: { remainingFraction: 1 } },
    'gemini-4-hydrogen-disabled': { disabled: true, displayName: 'Gemini 4 Hydrogen' },
  } })) as unknown as typeof fetch))!;
  account.quotaWindows = [{ groupName: 'Gemini Models', window: 'weekly', remainingFraction: 1 }];
  return account;
}

describe('configured Sonar model support', () => {
  test('enriches discovered metadata without advertising an undiscovered model or another route', async () => {
    const account = await discoverSonar();
    const model = getAvailableModelCatalog([account]).find(m => m.id === `antigravity-${id}`);
    expect(model).toMatchObject({ name: 'Gemini 4 Hydrogen Sonar', thinkingLevels: ['low', 'medium', 'high'], defaultThinkingLevel: 'low' });
    expect(account.availableModels?.[0]?.name).toBe('Gemini 4 Hydrogen Sonar');
    expect(getAvailableModelCatalog([]).some(m => m.id.includes('sonar'))).toBe(false);
    expect(accountSupportsModel(account, 'antigravity-gemini-4-hydrogen', 'high')).toBe(false);
    expect(getAccountModelPool(account, id)).toBe('Gemini Models');
  });

  test.each(['low', 'medium', 'high'])('keeps Sonar routing and output limits when selecting %s through either API format', async effort => {
    const account = await discoverSonar();
    const requests = [
      adaptChatCompletionRequest({ model: `antigravity-${id}`, messages: [{ role: 'user', content: 'Reply OK' }], reasoning_effort: effort, max_tokens: 128 }),
      adaptResponsesRequest({ model: `antigravity-${id}`, input: 'Reply OK', reasoning: { effort }, max_output_tokens: 128 }),
    ];
    for (const request of requests) {
      expect(validateCompletionRequestForGoogle(request)).toBeUndefined();
      const body = transformCompletionToGoogleBody(request, 'project', '', undefined, false, findAccountModel(account, request.model, request.reasoningEffort));
      expect(body.model).toBe(id);
      expect(body.request.labels.model_enum).toBe('MODEL_PLACEHOLDER_M578');
      expect(body.request.generationConfig).toMatchObject({ maxOutputTokens: 128, thinkingConfig: { includeThoughts: true, thinkingLevel: effort.toUpperCase() } });
    }
  });

  test('uses Low by default and caps output at the discovered Sonar limit', async () => {
    const account = await discoverSonar();
    const body = transformCompletionToGoogleBody({ model: `antigravity-${id}`, messages: [{ role: 'user', content: 'Reply OK' }], maxOutputTokens: 100000, stream: false }, 'project', '', undefined, false, findAccountModel(account, id));
    expect(body.request.generationConfig.maxOutputTokens).toBe(65536);
    expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe('LOW');
  });

  test('rejects unsupported Sonar effort before execution while preserving standard Hydrogen XHigh', () => {
    for (const request of [
      adaptChatCompletionRequest({ model: `antigravity-${id}`, messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'xhigh' }),
      adaptResponsesRequest({ model: `antigravity-${id}`, input: 'Hi', reasoning: { effort: 'xhigh' } }),
      adaptChatCompletionRequest({ model: `antigravity-${id}-xhigh`, messages: [{ role: 'user', content: 'Hi' }] }),
    ]) expect(validateCompletionRequestForGoogle(request)).toContain('Supported levels: low, medium, high');
    expect(getModelReasoningError('antigravity-gemini-4-hydrogen', 'xhigh')).toBeUndefined();
  });

  test('refuses standard Hydrogen on Sonar-only accounts even in rescue selection', async () => {
    const saved = [...getAccounts()];
    try {
      getAccounts().splice(0, getAccounts().length, await discoverSonar());
      expect((await getBestAccount('sandbox', `antigravity-${id}`, undefined, [], false, undefined, undefined, 'high'))?.email).toBe('sonar@example.com');
      expect(await getBestAccount('sandbox', 'antigravity-gemini-4-hydrogen', undefined, [], false, undefined, undefined, 'high')).toBeNull();
    } finally { getAccounts().splice(0, getAccounts().length, ...saved); }
  });

  test('applies metadata configuration to future models without model-specific branches', () => {
    const models = getProxyConfig().models;
    const previous = models.overrides;
    try {
      models.overrides = { 'gemini-future': { name: 'Future Preview', thinkingLevels: ['low', 'medium'], defaultThinkingLevel: 'medium' } };
      const account = { refreshToken: 'refresh', availableModels: [{ id: 'gemini-future', name: 'Upstream', supportsThinking: true, thinkingLevel: 1 }] } as AntigravityAccount;
      expect(getAvailableModelCatalog([account]).find(m => m.id === 'antigravity-gemini-future')).toMatchObject({ name: 'Future Preview', defaultThinkingLevel: 'medium', thinkingLevels: ['low', 'medium'] });
      expect(getModelReasoningError('gemini-future', 'high')).toContain('does not support');
      expect(transformCompletionToGoogleBody({ model: 'gemini-future', messages: [{ role: 'user', content: 'Hi' }], stream: false }, 'project', '', undefined, false, account.availableModels![0]).request.generationConfig.thinkingConfig.thinkingLevel).toBe('MEDIUM');
    } finally { models.overrides = previous; }
  });

  test('validates overrides and rejects invalid names, levels and defaults', () => {
    expect(() => validateModelMetadataOverrides(getProxyConfig().models.overrides)).not.toThrow();
    for (const value of [[], null, { x: null }, { 'antigravity-x': {} }, { x: { id: 'different-route' } }, { x: { name: '' } }, { x: { thinkingLevels: [] } }, { x: { thinkingLevels: ['low', 'low'] } }, { x: { thinkingLevels: ['unknown'] } }, { x: { thinkingLevels: ['low'], defaultThinkingLevel: 'high' } }]) {
      expect(() => validateModelMetadataOverrides(value)).toThrow();
    }
  });
});
