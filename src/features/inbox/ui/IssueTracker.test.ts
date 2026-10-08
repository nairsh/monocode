// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLocalIssue,
  loadLocalIssues,
  updateLocalIssue,
  type LocalIssue,
} from "../model/localIssues";
import { IssueTracker } from "./IssueTracker";
import type { Session } from "../../sessions/model/session";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(onLaunch = vi.fn(async (_issue: LocalIssue) => {})) {
  await act(async () =>
    root.render(
      createElement(IssueTracker, {
        cwd: "/tmp/web",
        recents: [],
        onLaunch,
      }),
    ),
  );
  return onLaunch;
}
function seed() {
  return createLocalIssue({
    title: "Fix clipping",
    description: "Old details",
    status: "backlog",
    priority: 2,
    projectPath: "/tmp/web",
    agent: "",
    labels: ["ui"],
  });
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    field instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

it("opens issue creation with C, focuses the title, and closes with Escape", async () => {
  await render();
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true }),
    ),
  );
  expect(
    document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
  ).toBe("Create issue");
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Issue title",
  );
  expect(document.querySelector('[aria-label="Agent prompt"]')).toBeNull();
  expect(document.querySelector('[aria-label="Assign agent"]')).toBeNull();
  expect(document.body.textContent).not.toContain("GitHub");
  expect(container.inert).toBe(true);
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.inert).toBe(false);
});

it("switches between Kanban and list layouts without changing issues", async () => {
  seed();
  await render();
  act(() => button("List view").click());
  expect(container.querySelector(".it-list")).not.toBeNull();
  act(() => button("Kanban view").click());
  expect(container.querySelector(".it-list")).toBeNull();
  expect(loadLocalIssues()).toHaveLength(1);
});

it("saves pending detail edits when the user leaves with Escape", async () => {
  const issue = seed();
  await render();
  act(() => button(`Open MC-${issue.number}: Fix clipping`).click());
  act(() => button("Edit issue description").click());
  const description = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Issue description"]',
  )!;
  act(() => type(description, "New acceptance criteria"));
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(loadLocalIssues()[0].description).toBe("New acceptance criteria");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("dispatches an issue dropped on the hidden To Do column with its full saved details", async () => {
  const issue = seed();
  const launch = vi.fn(async (assigned: LocalIssue) => {
    updateLocalIssue(assigned.id, {
      status: "in_progress",
      runState: "running",
      sessionId: "issue-thread",
    });
  });
  await render(launch);
  const target = [
    ...container.querySelectorAll<HTMLButtonElement>(
      ".it-hidden-columns button",
    ),
  ].find((button) => button.textContent?.includes("To Do"))!;
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", {
    value: { getData: () => issue.id },
  });
  await act(async () => target.dispatchEvent(drop));
  expect(launch).toHaveBeenCalledTimes(1);
  expect(launch.mock.calls[0][0]).toMatchObject({
    description: "Old details",
    labels: ["ui"],
    status: "todo",
  });
  expect(
    container.querySelector('[aria-label="In Progress issues"]'),
  ).not.toBeNull();
  expect(loadLocalIssues()[0].sessionId).toBe("issue-thread");
});

it("shows and clears an empty search state without losing the issue", async () => {
  seed();
  await render();
  const search = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search issues"]',
  )!;
  act(() => type(search, "no-match"));
  expect(container.textContent).toContain("No matching issues");
  act(() => button("Clear issue search").click());
  expect(
    container.querySelector('button[aria-label="Open MC-1: Fix clipping"]'),
  ).not.toBeNull();
  expect(loadLocalIssues()).toHaveLength(1);
});

it("opens a right-click issue menu with status, priority, and archive actions", async () => {
  seed();
  await render();
  act(() =>
    container.querySelector(".it-card")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 300,
      }),
    ),
  );
  const menu = document.querySelector('[aria-label="Issue actions"]')!;
  expect(menu.textContent).toContain("Change status");
  expect(menu.textContent).toContain("Set priority");
  act(() =>
    [...menu.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Archive issue"))!
      .click(),
  );
  expect(loadLocalIssues()[0].archived).toBe(true);
  expect(document.querySelector('[aria-label="Issue actions"]')).toBeNull();
});

it("does not open an issue menu on navigation, empty columns, or the page header", async () => {
  seed();
  await render();
  for (const selector of [
    ".it-sidebar",
    ".it-page-header",
    ".it-hidden-columns",
  ]) {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => container.querySelector(selector)!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[aria-label="Issue actions"]')).toBeNull();
  }
});

it("shows saved review evidence and resumes the linked thread with feedback", async () => {
  const issue = seed();
  updateLocalIssue(issue.id, {
    status: "in_review",
    sessionId: "same-thread",
    runState: "completed",
    reviews: [
      {
        id: "review",
        text: "Changed layout. ![Proof](/tmp/proof.png)",
        at: new Date().toISOString(),
        kind: "work",
      },
    ],
  });
  const launch = await render();
  act(() => button(`Open MC-${issue.number}: Fix clipping`).click());
  expect(document.querySelector(".it-review")?.textContent).toContain(
    "Changed layout.",
  );
  const comment = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Add issue detail"]',
  )!;
  act(() => type(comment, "Please adjust spacing"));
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Send feedback and iterate")!
      .click(),
  );
  expect(launch.mock.calls[0][0]).toMatchObject({
    sessionId: "same-thread",
    feedback: "Please adjust spacing",
    status: "in_progress",
    runKind: "work",
  });
});

it("approves a review as a commit run in the same thread", async () => {
  const issue = seed();
  updateLocalIssue(issue.id, {
    status: "in_review",
    sessionId: "same-thread",
    runState: "completed",
    reviews: [
      {
        id: "review",
        text: "Validated",
        at: new Date().toISOString(),
        kind: "work",
      },
    ],
  });
  const launch = await render();
  act(() => button(`Open MC-${issue.number}: Fix clipping`).click());
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Approve and commit")!
      .click(),
  );
  expect(launch.mock.calls[0][0]).toMatchObject({
    sessionId: "same-thread",
    runKind: "commit",
    status: "in_progress",
  });
  expect(container.textContent).not.toContain("My work");
  expect(container.textContent).not.toContain("Stored on this device");
});

it("renders chunked chat activity with collapsible tool details", async () => {
  const issue = seed();
  updateLocalIssue(issue.id, {
    status: "in_review",
    sessionId: "thread",
    runState: "completed",
  });
  const read = vi.fn(
    async () =>
      ({
        blocks: [
          { id: "u", role: "user", text: "Inspect layout", internal: true },
          { id: "a", role: "assistant", text: "Checking the layout" },
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `t-${index}`,
            role: "tool",
            text: `All checks passed ${index}`,
            tool: { kind: "shell", status: "completed" },
          })),
          { id: "final", role: "assistant", text: "Layout validated" },
        ],
      }) as Session,
  );
  await act(async () =>
    root.render(
      createElement(IssueTracker, {
        cwd: "/tmp/web",
        recents: [],
        onReadSession: read,
      }),
    ),
  );
  await act(async () =>
    button(`Open MC-${issue.number}: Fix clipping`).click(),
  );
  expect(read).toHaveBeenCalledWith("thread");
  expect(document.querySelector(".it-thread .agent-transcript")).not.toBeNull();
  expect(document.querySelector(".it-transcript")?.textContent).toContain(
    "Inspect layout",
  );
  expect(document.querySelector(".it-transcript")?.textContent).toContain(
    "Layout validated",
  );
  const toggle = document.querySelector<HTMLButtonElement>(
    '.it-transcript button[aria-label^="Show the steps for"]',
  )!;
  expect(toggle).not.toBeNull();
  act(() => toggle.click());
  expect(document.querySelector(".it-transcript")?.textContent).toContain(
    "All checks passed",
  );
});
