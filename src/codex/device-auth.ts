import { randomUUID } from "node:crypto";

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_SCOPE = "openid email profile offline_access";

export interface CodexCredentials {
  email: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
}

export type DeviceLoginPublicState = {
  loginId: string;
  status: "waiting" | "completed" | "failed" | "cancelled";
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  email?: string;
  error?: string;
};

type DeviceLoginInternalState = DeviceLoginPublicState & {
  deviceAuthId: string;
  intervalSeconds: number;
  cancelled: boolean;
  completion?: Promise<void>;
};

function parseJwt(token?: string): Record<string, any> {
  if (!token) return {};
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return {}; }
}

export class CodexDeviceAuthService {
  private readonly attempts = new Map<string, DeviceLoginInternalState>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly onCredentials?: (credentials: CodexCredentials) => Promise<void> | void;

  constructor(options: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    issuer?: string;
    clientId?: string;
    onCredentials?: (credentials: CodexCredentials) => Promise<void> | void;
  } = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.issuer = (options.issuer || DEFAULT_ISSUER).replace(/\/+$/, "");
    this.clientId = options.clientId || DEFAULT_CLIENT_ID;
    this.onCredentials = options.onCredentials;
  }

  async start(): Promise<DeviceLoginPublicState> {
    const response = await this.fetchImpl(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    if (!response.ok) {
      if (response.status === 404) throw new Error("device code login is not enabled for this Codex server");
      throw new Error(`device code request failed with status ${response.status}`);
    }
    const data: any = await response.json();
    const loginId = randomUUID();
    const state: DeviceLoginInternalState = {
      loginId,
      status: "waiting",
      verificationUrl: `${this.issuer}/codex/device`,
      userCode: String(data.user_code || data.usercode || ""),
      deviceAuthId: String(data.device_auth_id || ""),
      intervalSeconds: Math.max(1, Number(data.interval) || 1),
      expiresAt: Date.now() + 15 * 60_000,
      cancelled: false,
    };
    if (!state.userCode || !state.deviceAuthId) throw new Error("invalid device code response");
    this.attempts.set(loginId, state);
    state.completion = this.complete(state).catch(error => {
      if (state.cancelled) return;
      state.status = "failed";
      state.error = error?.message || String(error);
    });
    return this.publicState(state);
  }

  get(loginId: string): DeviceLoginPublicState | null {
    const state = this.attempts.get(loginId);
    return state ? this.publicState(state) : null;
  }

  async waitForCompletion(loginId: string): Promise<void> {
    const state = this.attempts.get(loginId);
    if (!state) throw new Error("Unknown device login");
    await state.completion;
  }

  cancel(loginId: string): boolean {
    const state = this.attempts.get(loginId);
    if (!state || state.status !== "waiting") return false;
    state.cancelled = true;
    state.status = "cancelled";
    return true;
  }

  private publicState(state: DeviceLoginInternalState): DeviceLoginPublicState {
    const { loginId, status, verificationUrl, userCode, expiresAt, email, error } = state;
    return { loginId, status, verificationUrl, userCode, expiresAt, ...(email ? { email } : {}), ...(error ? { error } : {}) };
  }

  private async complete(state: DeviceLoginInternalState): Promise<void> {
    let codeData: any;
    while (!state.cancelled && Date.now() < state.expiresAt) {
      const response = await this.fetchImpl(`${this.issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: state.deviceAuthId, user_code: state.userCode }),
      });
      if (response.ok) {
        codeData = await response.json();
        break;
      }
      if (response.status !== 403 && response.status !== 404) {
        throw new Error(`device auth failed with status ${response.status}`);
      }
      await this.sleep(state.intervalSeconds * 1000);
    }
    if (state.cancelled) return;
    if (!codeData) throw new Error("device auth timed out after 15 minutes");

    const tokenResponse = await this.fetchImpl(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: codeData.authorization_code,
        grant_type: "authorization_code",
        client_id: this.clientId,
        redirect_uri: `${this.issuer}/deviceauth/callback`,
        code_verifier: codeData.code_verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) throw new Error(`device code exchange failed with status ${tokenResponse.status}`);
    const tokens: any = await tokenResponse.json();
    const claims = parseJwt(tokens.id_token);
    const authInfo = claims["https://api.openai.com/auth"] || {};
    const credentials: CodexCredentials = {
      email: claims.email || "unknown",
      accountId: authInfo.chatgpt_account_id || claims.sub || "",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    };
    if (!credentials.accessToken || !credentials.refreshToken) throw new Error("device code exchange returned incomplete credentials");
    await this.onCredentials?.(credentials);
    state.email = credentials.email;
    state.status = "completed";
  }
}

export { DEFAULT_CLIENT_ID as CODEX_CLIENT_ID, DEFAULT_ISSUER as CODEX_AUTH_ISSUER, DEFAULT_SCOPE as CODEX_AUTH_SCOPE };
