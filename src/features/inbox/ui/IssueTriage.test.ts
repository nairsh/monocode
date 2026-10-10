// @vitest-environment happy-dom
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useIssueTriage, IssueDependencies } from "./IssueTriage";
import {
  createLocalIssue,
  loadLocalIssues,
  subscribeLocalIssues,
  updateLocalIssue,
  type LocalIssue,
} from "../model/localIssues";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.mocked(invoke).mockReset();
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

it("shows a triage plan, applies it, then starts one shared assignment", async () => {
  const a = seed("Streaming tokens");
  const b = seed("Streaming reconnect");
  vi.mocked(invoke).mockResolvedValue({
    groups: [
      {
        title: "Streaming",
        reason: "Shared stream state",
        files: ["src/stream.ts"],
        issueIds: [a.id, b.id],
      },
    ],
    dependencies: [],
  });
  const launch = vi.fn(async () => {});
  const error = vi.fn();
  await act(async () =>
    root.render(createElement(Harness, { launch, onError: error })),
  );
  await click("Triage");
  expect(container.textContent).toContain("Proposed assignments");
  expect(container.textContent).toContain("Shared stream state");
  expect(loadLocalIssues().every((issue) => !issue.triageGroup)).toBe(true);
  await click("Apply triage plan");
  expect(container.textContent).toContain("1 groups");
  await act(async () => {
    container.querySelector("details")!.open = true;
  });
  await click("Start group");
  expect(launch).toHaveBeenCalledTimes(1);
  expect(loadLocalIssues()[0]!.runBatchId).toBe(
    loadLocalIssues()[1]!.runBatchId,
  );
  expect(error).not.toHaveBeenCalled();
});

it("dismisses a proposal without changing tickets and reports endpoint failures", async () => {
  const a = seed("A");
  vi.mocked(invoke).mockResolvedValueOnce({
    groups: [
      { title: "A", reason: "Source context", files: [], issueIds: [a.id] },
    ],
    dependencies: [],
  });
  const error = vi.fn();
  await act(async () =>
    root.render(createElement(Harness, { launch: vi.fn(), onError: error })),
  );
  await click("Triage");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss triage plan"]')!
      .click(),
  );
  expect(loadLocalIssues()[0]!.triageGroup).toBeUndefined();
  vi.mocked(invoke).mockRejectedValueOnce(
    new Error("Configure a triage model"),
  );
  await click("Triage");
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Configure a triage model" }),
  );
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
