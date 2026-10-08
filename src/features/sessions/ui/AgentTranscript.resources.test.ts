// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";

const markdown = vi.hoisted(() => vi.fn());
vi.mock("./AgentMarkdown", () => ({
  AgentMarkdown: ({ text }: { text: string }) => {
    markdown(text);
    return createElement("div", null, text);
  },
}));
vi.mock("../hooks/useTranscriptLayout", () => ({ useTranscriptLayout: () => "full" }));
vi.mock("../hooks/useTranscriptAnchor", () => ({ useTranscriptAnchor: () => false }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("records loaded-history rendering work for 20, 200 and 2000 turns", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class {
    observe() {} unobserve() {} disconnect() {}
  });
  const measurements: { turns: number; mountedMessages: number; nodes: number }[] = [];
  for (const count of [20, 200, 2000]) {
    const blocks: Block[] = Array.from({ length: count }, (_, index): Block[] => [
      { id: `u${index}`, role: "user", text: `Question ${index}` },
      { id: `a${index}`, role: "assistant", text: `Answer ${index} ${"sample ".repeat(40)}` },
    ]).flat();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let reveal: ((id: string) => boolean) | undefined;
    markdown.mockClear();
    await act(async () => root.render(createElement(AgentTranscript, {
      blocks, visible: true, onRevealReady: (value) => { reveal = value; },
    })));
    act(() => { expect(reveal?.("u0")).toBe(true); });
    const mountedMessages = host.querySelectorAll(".user-message-bubble").length;
    measurements.push({ turns: count, mountedMessages, nodes: host.querySelectorAll("*").length });
    expect(host.textContent).toContain("Question 0");
    expect(host.textContent).toContain(`Answer ${count - 1}`);
    if (!process.env.MONOCODE_PERF_BASELINE && count > 100) {
      expect(mountedMessages).toBeLessThanOrEqual(25);
      expect(host.querySelectorAll("*").length).toBeLessThan(count * 3 + 500);
    }
    act(() => root.unmount());
    host.remove();
  }
  const directory = process.env.MONOCODE_PERF_OUTPUT_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "transcript-resources.json"), JSON.stringify(measurements, null, 2) + "\n");
  }
}, 20_000);

