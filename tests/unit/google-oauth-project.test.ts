import { describe, expect, test } from "bun:test";
import { getProjectId } from "../../src/auth/oauth";
import { ANTIGRAVITY_BASE_URL } from "../../src/api/endpoints";
import { getAntigravityNativeHeaders } from "../../src/utils/headers";

describe("Google OAuth project discovery", () => {
  test.each(["project-123", { id: "project-123" }])("discovers %p using the supported native Hub identity", async project => {
    let calls = 0;
    const fetchImpl = (async (url: string, options: RequestInit) => {
      calls++;
      expect(url).toBe(`${ANTIGRAVITY_BASE_URL}/v1internal:loadCodeAssist`);
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual(getAntigravityNativeHeaders("test-access-token"));
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const metadata = JSON.parse(options.body as string).metadata;
      expect(metadata).toEqual({ ideType: "ANTIGRAVITY" });
      // Upstream returns 200 for both supported and unsupported clients.
      return Response.json(metadata.ideType === "ANTIGRAVITY"
        ? { cloudaicompanionProject: project }
        : { ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT" }] });
    }) as typeof fetch;
    expect(await getProjectId("test-access-token", fetchImpl)).toBe("project-123");
    expect(calls).toBe(1);
  });

  test("does not treat an HTTP 200 unsupported-client response as a project", async () => {
    const fetchImpl = (async () => Response.json({ ineligibleTiers: [{ reasonCode: "UNSUPPORTED_CLIENT" }] })) as unknown as typeof fetch;
    expect(await getProjectId("test-access-token", fetchImpl)).toBe("");
  });

  test("rejects project data from unsuccessful responses", async () => {
    const fetchImpl = (async () => Response.json({ cloudaicompanionProject: "project-123" }, { status: 403 })) as unknown as typeof fetch;
    expect(await getProjectId("test-access-token", fetchImpl)).toBe("");
  });
});
