import { describe, expect, it } from "vitest";
import { AgentTokens } from "./agentTokens";

describe("subagent token snapshots", () => {
  it("replaces repeated requests and keeps agents independent", () => {
    const tokens = new AgentTokens();
    expect(tokens.record("a", "m1", 100)).toBe(100);
    expect(tokens.record("a", "m1", 120)).toBe(120);
    expect(tokens.record("a", "m2", 200)).toBe(320);
    expect(tokens.record("b", "m1", 50)).toBe(50);
    tokens.clear();
    expect(tokens.record("a", "m3", 10)).toBe(10);
  });
});
