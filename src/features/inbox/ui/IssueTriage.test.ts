// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runTriageAgent } from "../model/triageAgent";
import { useIssueTriage, IssueDependencies } from "./IssueTriage";
import {
  createLocalIssue,
  loadLocalIssues,
  subscribeLocalIssues,
  updateLocalIssue,
  type LocalIssue,
} from "../model/localIssues";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../model/triageAgent", () => ({ runTriageAgent: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.mocked(runTriageAgent).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const seed = (title: string) =>
  createLocalIssue({
    title,
    projectPath: "/repo",
    status: "backlog",
    description: title,
    priority: 0,
    labels: [],
    agent: "",
  });
function Harness({
  launch,
  onError,
}: {
  launch: (issue: LocalIssue) => Promise<void>;
  onError: (reason: unknown) => void;
}) {
  const [issues, setIssues] = useState(loadLocalIssues);
  useEffect(() => subscribeLocalIssues(() => setIssues(loadLocalIssues())), []);
  const triage = useIssueTriage(issues, "/repo", launch, onError);
  return createElement(
    "div",
    null,
    triage.button,
    triage.panel,
    issues[0]
      ? createElement(IssueDependencies, { issue: issues[0], onError })
      : null,
  );
}
const click = async (label: string) =>
  act(async () => {
    const target = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
    expect(target).toBeDefined();
    target!.click();
  });

it("triages immediately, applies issue updates, and undoes without losing later edits", async () => {
  const a = seed("Streaming tokens");
  const b = seed("Streaming reconnect");
  vi.mocked(runTriageAgent).mockResolvedValue({
    groups: [
      {
        title: "Streaming",
        reason: "Shared stream state",
        files: ["src/stream.ts"],
        issueIds: [a.id, b.id],
      },
    ],
    dependencies: [
      { issueId: b.id, dependsOn: a.id, reason: "Needs stream state" },
    ],
    updates: [
      {
        issueId: a.id,
        description: "## Task\nImprove streaming",
        priority: 2,
        reason: "Clarifies scope",
      },
    ],
  });
  const error = vi.fn();
  await act(async () =>
    root.render(createElement(Harness, { launch: vi.fn(), onError: error })),
  );
  await click("Triage");
  expect(container.textContent).toContain("2 issues triaged");
  expect(container.textContent).not.toContain("Proposed assignments");
  expect(loadLocalIssues()[0].priority).toBe(2);
  expect(loadLocalIssues()[1].dependsOn).toEqual([a.id]);
  await act(async () => {
    updateLocalIssue(a.id, { title: "User's later title" });
  });
  await click("Undo changes");
  expect(loadLocalIssues()[0].title).toBe("User's later title");
  expect(loadLocalIssues()[0].priority).toBe(0);
  expect(loadLocalIssues()[0].description).toBe(a.description);
  expect(loadLocalIssues()[0].triageGroup).toBeUndefined();
  expect(loadLocalIssues()[1].dependsOn).toBeUndefined();
  expect(error).not.toHaveBeenCalled();
});

it("reports agent failures without changing tickets", async () => {
  const a = seed("A");
  vi.mocked(runTriageAgent).mockRejectedValueOnce(
    new Error("Configure a triage model"),
  );
  const error = vi.fn();
  await act(async () =>
    root.render(createElement(Harness, { launch: vi.fn(), onError: error })),
  );
  await click("Triage");
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("Configure a triage model"),
    }),
  );
  expect(loadLocalIssues()[0]).toEqual(a);
});

it("allows adding and removing prerequisites and surfaces a cycle without applying it", async () => {
  const a = seed("A");
  const b = seed("B");
  const error = vi.fn();
  updateLocalIssue(b.id, { dependsOn: [a.id] });
  await act(async () =>
    root.render(createElement(Harness, { launch: vi.fn(), onError: error })),
  );
  const add = async (id: string) =>
    act(async () => {
      const select = container.querySelector<HTMLSelectElement>(
        '[aria-label="Add issue dependency"]',
      )!;
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!.call(select, id);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await add(b.id);
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("cycle") }),
  );
  expect(loadLocalIssues()[0]!.dependsOn).toBeUndefined();
  await act(async () => {
    updateLocalIssue(b.id, { dependsOn: [] });
  });
  await add(b.id);
  expect(loadLocalIssues()[0]!.dependsOn).toEqual([b.id]);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        `[aria-label="Remove dependency MC-${b.number}"]`,
      )!
      .click(),
  );
  expect(loadLocalIssues()[0]!.dependsOn).toEqual([]);
});
