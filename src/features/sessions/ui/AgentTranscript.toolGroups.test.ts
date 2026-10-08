// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { AgentTranscript } from "./AgentTranscript";
import { previewFromTool } from "../../../integrations/harness/providers/claude/claudeProtocol";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function tool(id: string): Block {
  return {
    id,
    role: "tool",
    text: `Inspect step-${id}`,
    tool: { kind: "shell", status: "completed" },
  };
}

const run = (prefix: string) =>
  Array.from({ length: 10 }, (_, index) => tool(`${prefix}${index}`));

describe("tool-call groups", () => {
  it("splits tools, a message and tools into three independent elements", () => {
    const blocks: Block[] = [
      { id: "user", role: "user", text: "Go", durationMs: 5_000 },
      ...run("a"),
      { id: "note", role: "assistant", text: "Checking the other half." },
      ...run("b"),
      { id: "answer", role: "assistant", text: "All done." },
    ];
    act(() => root.render(createElement(AgentTranscript, { blocks })));

    // The message between the runs reads as transcript text, not folded work.
    expect(container.textContent).toContain("Checking the other half.");
    expect(container.textContent).toContain("All done.");
    expect(container.querySelector('[aria-label="Show the work"]')).toBeNull();

    const toggles = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Show the steps for"]',
    );
    expect(toggles).toHaveLength(2);
    expect(container.textContent).not.toContain("step-a0");

    act(() => toggles[0].click());
    expect(container.textContent).toContain("step-a0");
    expect(container.textContent).not.toContain("step-b0");

    // Collapsing eases shut: the rows stay until the transition has played.
    const hide = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Hide the steps for"]',
    )!;
    act(() => hide.click());
    expect(container.textContent).toContain("step-a0");
    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).not.toContain("step-a0");
  });

  it("shows an edit's line counts beside the file", () => {
    const blocks: Block[] = [
      { id: "user", role: "user", text: "Fix it" },
      {
        id: "edit",
        role: "tool",
        text: "Edit src/app.ts",
        tool: {
          kind: "edit",
          status: "completed",
          preview: {
            kind: "write",
            path: "/repo/src/app.ts",
            additions: 12,
            deletions: 3,
            lines: [{ kind: "add", text: "x" }],
          },
        },
      },
    ];
    act(() =>
      root.render(createElement(AgentTranscript, { blocks, cwd: "/repo" })),
    );
    const counts = container.querySelector('[aria-label="12 added, 3 removed"]');
    expect(counts?.textContent).toBe("+12 -3");
  });

  it("shows counts from a Claude Edit beside its file", () => {
    const preview = previewFromTool("Edit", {
      file_path: "/repo/src/app.ts",
      old_string: "old\n",
      new_string: "new\nextra\n",
    });
    act(() => root.render(createElement(AgentTranscript, {
      cwd: "/repo",
      blocks: [
        { id: "user", role: "user", text: "Fix it" },
        { id: "edit", role: "tool", text: "Edit", tool: {
          kind: "edit", status: "completed", preview,
        } },
      ],
    })));
    expect(container.querySelector('[aria-label="2 added, 1 removed"]')?.textContent)
      .toBe("+2 -1");
  });
});
