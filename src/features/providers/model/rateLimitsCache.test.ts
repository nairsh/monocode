import { describe, expect, it, vi } from "vitest";
import { errorRateLimits } from "./rateLimits";

const fetchClaude = vi.fn();
vi.mock("./rateLimitsFetch", () => ({
  fetchClaudeRateLimits: (...args: unknown[]) => fetchClaude(...args),
  fetchCodexRateLimits: vi.fn(),
  fetchOpencodeGoRateLimits: vi.fn(),
}));

const { loadRateLimits } = await import("./rateLimitsCache");

describe("loadRateLimits", () => {
  it("keeps the last good windows when a refresh fails", async () => {
    const session = { usedPercent: 40, resetsAt: null, windowMinutes: 300 };
    fetchClaude.mockResolvedValueOnce({
      provider: "claude",
      session,
      weekly: null,
      monthly: null,
      resetCredits: null,
      updatedAt: 1,
      error: null,
      status: "ok",
    });
    await loadRateLimits("claude", "default", true);

    fetchClaude.mockResolvedValueOnce(errorRateLimits("claude", "429"));
    const after = await loadRateLimits("claude", "default", true);
    expect(after.status).toBe("error");
    expect(after.error).toBe("429");
    expect(after.session).toEqual(session);
  });
});
