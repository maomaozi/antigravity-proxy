import { describe, expect, test } from 'bun:test';
import { fetchQuota, fetchQuotaWindows } from '../../src/api/quota';
import type { AntigravityAccount } from '../../src/auth/types';

const account = (): AntigravityAccount => ({
  email: 'quota@example.com', refreshToken: 'refresh', accessToken: 'access',
  projectId: 'legacy-project', healthScore: 100, lastUsed: 0, tokenUsage: 0,
});

describe('Antigravity quota summary', () => {
  test('retrieves separate shared five-hour and weekly windows, including exhausted protobuf defaults', async () => {
    let sent: { url: string; init?: RequestInit } | undefined;
    const fakeFetch = (async (input: any, init?: RequestInit) => {
      sent = { url: String(input), init };
      return Response.json({ groups: [
        { displayName: 'Gemini Models', buckets: [
          { window: 'weekly', remainingFraction: 0.25, resetTime: '2026-10-31T00:00:00Z' },
          { window: '5h', remainingFraction: 0.8 },
          { window: 'monthly', remainingFraction: 1 },
        ] },
        { displayName: 'Claude and GPT models', buckets: [
          { window: 'weekly', resetTime: '2026-10-30T00:00:00Z' },
          { window: '5h', remainingFraction: 1 },
        ] },
      ] });
    }) as unknown as typeof fetch;
    const result = await fetchQuotaWindows(account(), fakeFetch);
    expect(sent?.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
    expect(JSON.parse(String(sent?.init?.body))).toEqual({ project: 'aicode-consumers' });
    expect(new Headers(sent?.init?.headers).get('user-agent')).toContain('cl=1005016104');
    expect(result?.map(({ groupName, window, remainingFraction }) => ({ groupName, window, remainingFraction }))).toEqual([
      { groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.25 },
      { groupName: 'Gemini Models', window: '5h', remainingFraction: 0.8 },
      { groupName: 'Claude and GPT models', window: 'weekly', remainingFraction: 0 },
      { groupName: 'Claude and GPT models', window: '5h', remainingFraction: 1 },
    ]);
  });

  test('keeps unavailable or malformed summaries distinct from an exhausted window', async () => {
    for (const response of [Response.json({ error: 'unavailable' }, { status: 503 }), Response.json({}), Response.json({ groups: null })]) {
      expect(await fetchQuotaWindows(account(), (async () => response) as unknown as typeof fetch)).toBeNull();
    }
    expect(await fetchQuotaWindows(account(), (async () => Response.json({ groups: [] })) as unknown as typeof fetch)).toEqual([]);
  });

  test('does not expose disabled or retired models through quota cards', async () => {
    const result = await fetchQuota(account(), false, (async () => Response.json({ models: {
      'gemini-4-argon-disabled': { displayName: 'Gemini 4 Argon', disabled: true, quotaInfo: { remainingFraction: 1 } },
      'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)', quotaInfo: { remainingFraction: 1 } },
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.9 } },
    } })) as unknown as typeof fetch);
    expect(result?.map(item => item.modelId)).toEqual(['gemini-3.8-flash-high']);
  });
});
