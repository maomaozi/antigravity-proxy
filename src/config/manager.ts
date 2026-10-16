import { type ProxyConfig } from './types';
import { EventEmitter } from 'node:events';
import { readDurableJson, writeDurableJson } from '../utils/durable-json';

const CONFIG_PATH = 'config.json';
export const configEventBus = new EventEmitter();

let config: ProxyConfig;

const DEFAULT_CONFIG: ProxyConfig = {
  rotation: {
    cooldown: {
      defaultDurationMs: 60000,
      maxDurationMs: 3600000
    }
  },
  scoring: {
    healthRange: {
      min: 0,
      max: 100,
      initial: 100
    },
    penalties: {
      apiError: -10,
      refreshError: -20,
      fatalError: -50,
      systemicError: -5
    },
    rewards: {
      success: 1
    },
    weights: {
      health: 2.0,
      lru: 0.1
    }
  },
  models: {
    blacklist: [],
    routing: {
      sandboxKeywords: ['gpt', 'antigravity', 'image'],
      cliKeywords: ['claude', 'gemini-2.0', 'gemini-2.5', '-preview'],
      forceToSandbox: ['gpt']
    },
    timeouts: {
      'default': 120000,
      'firstByte': 120000,
      'stream': 900000,
      'claude': 120000,
      'gemini-3-pro': 120000,
      'gemini-3.1-pro': 120000,
      'thinking': 180000
    }
  },
  retry: {
    maxAttempts: 5,
    transientRetryThresholdSeconds: 5
  },
  tokens: {
    expiryBufferMs: 60000
  },
  quota: {
    refreshIntervalMs: 300000,
    initialDelayMs: 10000
  },
    endpoints: {
      sandbox: [
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://autopush-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse'
      ],
      cli: [
        'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
        'https://autopush-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
      ]
    },
  logging: {
    maxBufferSize: 200,
    enableConsoleCapture: true
  },
  features: {
    googleSearchGrounding: false,
    groundingMode: 'auto',
    keepThinking: false,
    sanitizeToolNames: true,
    pidOffsetEnabled: false,
    softQuotaThresholdPercent: 90,
    jitterEnabled: true,
    jitterMinMs: 50,
    jitterMaxMs: 300
  },
  scheduling: {
    maxCacheFirstWaitSeconds: 60
  },
  codex: {
    enabled: true,
    models: [],
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    responsesTimeoutMs: 120000,
    compactTimeoutMs: 60000,
    maxAttempts: 3
  }
};

function decodeConfig(value: unknown): Partial<ProxyConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid proxy configuration');
  return value as Partial<ProxyConfig>;
}

export async function loadProxyConfig(): Promise<ProxyConfig> {
  try {
    const loadedConfig = await readDurableJson(CONFIG_PATH, decodeConfig);
    
    if (!loadedConfig) {
      console.log('[Config] config.json not found, creating with defaults...');
      await saveProxyConfig(DEFAULT_CONFIG);
      config = DEFAULT_CONFIG;
      return config;
    }
    
    config = deepMerge(DEFAULT_CONFIG, loadedConfig) as ProxyConfig;
    // Ignore legacy strategy/mode fields. Session affinity with cache-first failover is fixed.
    delete (config.rotation as ProxyConfig['rotation'] & { strategy?: unknown }).strategy;
    delete (config.scheduling as ProxyConfig['scheduling'] & { mode?: unknown }).mode;
    delete (config.scheduling as ProxyConfig['scheduling'] & { maxRateLimitWaitSeconds?: unknown }).maxRateLimitWaitSeconds;
    await writeDurableJson(CONFIG_PATH, loadedConfig, decodeConfig);
    console.log('[Config] Loaded configuration.');
    return config;
  } catch (e) {
    console.error('[Config] Failed to load config.json:', e);
    throw e;
  }
}

export async function saveProxyConfig(newConfig: ProxyConfig): Promise<void> {
  try {
    await writeDurableJson(CONFIG_PATH, newConfig, decodeConfig);
    config = newConfig;
    configEventBus.emit('update', config);
    console.log('[Config] Configuration saved successfully');
  } catch (e) {
    console.error('[Config] Failed to save config.json:', e);
    throw e;
  }
}

export function getProxyConfig(): ProxyConfig {
  return config || DEFAULT_CONFIG;
}

export async function updateProxyConfig(updates: Partial<ProxyConfig>): Promise<ProxyConfig> {
  const merged = deepMerge(config, updates);
  await saveProxyConfig(merged);
  return merged;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
}
