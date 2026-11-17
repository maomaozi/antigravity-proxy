import { OAUTH_CONFIG, getAntigravityNativeHeaders } from "../utils/headers";
import { type GoogleTokenResponse } from "./types";
import { ANTIGRAVITY_BASE_URL } from "../api/endpoints";

export function generateAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    response_type: "code",
    scope: OAUTH_CONFIG.scopes.join(" "),
    access_type: "offline",
    prompt: "consent", 
    // Static challenge to match repo analysis
    code_challenge: "cFH3lPzU2FhJjQhHlGqKqQhHlGqKqQhHlGqKqQhHlGq", 
    code_challenge_method: "plain"
  });
  return `${OAUTH_CONFIG.authUri}?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    client_secret: OAUTH_CONFIG.clientSecret, // REQUIRED for this Client ID
    redirect_uri: OAUTH_CONFIG.redirectUri,
    grant_type: "authorization_code",
    code: code,
    code_verifier: "cFH3lPzU2FhJjQhHlGqKqQhHlGqKqQhHlGqKqQhHlGq" 
  });

  const res = await fetch(OAUTH_CONFIG.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params // Bun's fetch handles URLSearchParams body correctly
  });

  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return await res.json() as GoogleTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const params = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    client_secret: OAUTH_CONFIG.clientSecret, // REQUIRED for this Client ID
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const res = await fetch(OAUTH_CONFIG.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return await res.json() as GoogleTokenResponse;
}

export async function getProjectId(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    // Hub uses ANTIGRAVITY. Legacy IDE identities can return HTTP 200 with
    // UNSUPPORTED_CLIENT and no project, rather than an HTTP error.
    const res = await fetchImpl(`${ANTIGRAVITY_BASE_URL}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers: getAntigravityNativeHeaders(accessToken),
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const data = await res.json() as any;
      const project = data?.cloudaicompanionProject;
      const projectId = typeof project === "string" ? project : project?.id;

      if (typeof projectId === "string" && projectId) {
        console.log("[OAuth] Discovered Project ID using ANTIGRAVITY");
        return projectId;
      }
    }
  } catch (e) {
    console.warn("[OAuth] Failed to fetch project ID with ANTIGRAVITY:", e);
  }

  return "";
}

export async function getUserEmail(accessToken: string): Promise<string> {
   const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
   });
   if (!res.ok) throw new Error("Failed to fetch user info");
   const data = await res.json() as any;
   return data.email as string;
}
