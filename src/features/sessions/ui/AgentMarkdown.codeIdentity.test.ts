// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";
vi.mock("./wordFade", async (original) => ({
  ...(await original<typeof import("./wordFade")>()),
  usePacedText: (text: string) => ({ text, revealing: false }),
  useWordFading: (streaming: boolean) => streaming,
}));

it("preserves code DOM when prose fading ends after stream completion", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const text = "Before\n\n```typescript\nconst value = 1;\n```\n\nAfter";
  try {
    await act(async () => root.render(createElement(AgentMarkdown, { text, streaming: true })));
    const code = host.querySelector("pre")!;
    expect(code).not.toBeNull();
    await act(async () => root.render(createElement(AgentMarkdown, { text, streaming: false })));
    expect(host.querySelector("pre")).toBe(code);
    expect(host.textContent).toContain("const value = 1;");
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
