/** Official Antigravity Hub endpoint; account failover never changes this host. */
export const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_STREAM_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:streamGenerateContent?alt=sse`;
export const ANTIGRAVITY_IMAGE_URL = `${ANTIGRAVITY_BASE_URL}/v1internal:generateContent`;
