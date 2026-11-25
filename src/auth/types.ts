import type { DiscoveredModel } from "../models";

export interface DeviceFingerprint {
  userAgent: string;
  quotaUser: string;
  deviceId: string;
  platform: string;
  apiClient: string;
  ideType: string;
  platformName: string;
  sessionToken: string;
  clientMetadata?: {
    ideType: string;
    platform: string;
    pluginType: string;
    osVersion?: string;
    arch?: string;
    sqmId?: string;
  };
  createdAt?: number;
}

export interface PoolSuspension {
  reason: string;
  status?: "suspended" | "pending_verification";
  message?: string;
  appealUrl?: string;
  detectedAt: number;
  retryAt: number;
  model: string;
  permanent?: boolean;
}

export interface ServiceSuspension {
  service?: "antigravity";
  status?: "suspended" | "pending_verification";
  reason: string;
  message?: string;
  appealUrl?: string;
  detectedAt: number;
  model?: string;
}

export interface AntigravityAccount {
  email: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number; // timestamp
  projectId?: string;
  managedProjectId?: string;
  disabled?: boolean;
  disabledPools?: string[];
  poolSuspensions?: Record<string, PoolSuspension>;
  /** Legacy Antigravity suspension with no recorded model or pool. */
  suspension?: ServiceSuspension;
  
  // Routing health stats
  healthScore: number;
  modelScores?: Record<string, number>;
  lastUsed: number;
  tokenUsage: number;
  consecutiveFailures?: number;
  cooldowns?: Record<string, number>;
  history?: Array<{ timestamp: number; status: 'success' | 'error' }>;
  
  // Device fingerprint (persistent per account)
  fingerprint?: DeviceFingerprint;
  
  challenge?: {
    type: string;
    url: string;
    detectedAt: number;
    reason?: string;
    message?: string;
  };
  capabilities?: Record<string, boolean>;
  availableModels?: DiscoveredModel[];
  
  // Quota info (cached) and independent successful collection timestamps
  quotaUpdatedAt?: number;
  quotaWindowsUpdatedAt?: number;
  quotaWindows?: Array<{
    groupName: string;
    window: '5h' | 'weekly';
    remainingFraction: number;
    resetTime?: string;
  }>;
  quota?: Array<{
    groupName: string; // e.g., "Gemini 1.5 Pro"
    limit: string;
    usage: string;
    limitName: string;
    remainingFraction: number; // 0.0 - 1.0
    quotaLeft: string; // e.g., "80%"
    resetIn: string; // e.g., "14h 20m"
    windowActive?: boolean;
    modelId?: string;
    modelIds?: string[];
    familyName?: string;
    resetTime?: string; // ISO date
  }>
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
  refresh_token?: string;
}
