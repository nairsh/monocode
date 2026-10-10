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
import { polishIssue } from "../../settings/model/taskModel";

vi.mock("../../settings/model/taskModel", () => ({ polishIssue: vi.fn() }));

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
  vi.mocked(polishIssue).mockReset();
  vi.mocked(polishIssue).mockResolvedValue({
    title: "Generated title",
    description: "Polished details",
    priority: 0,
  });
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

it("opens issue creation with C, focuses the description, and closes with Escape", async () => {
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
    "Issue description",
  );
  expect(document.querySelector('[aria-label="Issue title"]')).toBeNull();
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

it("applies the polished priority only while the draft has no priority", async () => {
  vi.mocked(polishIssue).mockResolvedValue({
    title: "Generated title",
    description: "Polished details",
    priority: 3,
  });
  await render();
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true }),
    ),
  );
  act(() =>
    type(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Issue description"]',
      )!,
      "Dashboard is slow",
    ),
  );
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        '.it-create-footer button[type="submit"]',
      )!
      .click(),
  );
  expect(loadLocalIssues()[0]!.priority).toBe(3);
});

it("shows the commit sha on the card and loads its files only on hover", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  vi.mocked(invoke).mockResolvedValue([{ relative: "src/a.ts" }]);
  reviewed({
    status: "done",
    commitSha: "abc1234def5678",
    commitMeta: {
      subject: "fix: stop clipping",
      author: "Ada",
      at: new Date(2026, 0, 2).toISOString(),
    },
  });
  await render();
  const chip = document.querySelector<HTMLElement>(".it-card .it-sha")!;
  expect(chip.textContent).toBe("#abc1234");
  expect(invoke).not.toHaveBeenCalled();
  await act(async () =>
    chip.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
  );
  expect(invoke).toHaveBeenCalledWith("git_commit_files", {
    cwd: "/tmp/web",
    sha: "abc1234def5678",
  });
  expect(document.body.textContent).toContain("fix: stop clipping");
  expect(document.body.textContent).toContain("src/a.ts");
});

it("preserves the draft and creates nothing when polishing fails, then retries", async () => {
  vi.mocked(polishIssue).mockRejectedValueOnce(new Error("Endpoint offline"));
  await render();
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true }),
    ),
  );
  const description = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Issue description"]',
  )!;
  act(() => type(description, "Please fix the spacing"));
  const submit = document.querySelector<HTMLButtonElement>(
    '.it-create-footer button[type="submit"]',
  )!;
  await act(async () => submit.click());
  expect(loadLocalIssues()).toHaveLength(0);
  expect(description.value).toBe("Please fix the spacing");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Endpoint offline",
  );
  await act(async () => submit.click());
  expect(polishIssue).toHaveBeenLastCalledWith("Please fix the spacing");
  expect(loadLocalIssues()).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("prevents duplicate creation and closing while polishing is pending", async () => {
  let resolve!: (value: { title: string; description: string }) => void;
  vi.mocked(polishIssue).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true }),
    ),
  );
  const description = document.querySelector<HTMLTextAreaElement>(
    '[aria-label="Issue description"]',
  )!;
  act(() => type(description, "Draft"));
  await act(async () => {
    const form = document.querySelector(".it-dialog form")!;
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(
    document.querySelector<HTMLFieldSetElement>(".it-create-fields")?.disabled,
  ).toBe(true);
  expect(polishIssue).toHaveBeenCalledTimes(1);
  await act(async () =>
    resolve({
      title: "Generated title",
      description: "Polished details",
      priority: 0,
    }),
  );
  expect(loadLocalIssues()).toHaveLength(1);
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
  const fire = (el: Element, type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { setData: () => {}, getData: () => "" },
    });
    return act(async () => el.dispatchEvent(event));
  };
  await fire(container.querySelector(".it-card")!, "dragstart");
  await fire(target, "dragover");
  expect(target.classList.contains("it-drop-target")).toBe(true);
  await fire(target, "drop");
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
    status: "done",
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

function reviewed(patch: Partial<LocalIssue> = {}) {
  const issue = seed();
  updateLocalIssue(issue.id, {
    status: "in_review",
    sessionId: "same-thread",
    runState: "completed",
    agent: "codex",
    reviews: [
      {
        id: "review",
        text: "Validated",
        at: new Date().toISOString(),
        kind: "work",
      },
    ],
    ...patch,
  });
  return issue;
}
function buttonByText(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === text,
  );
}

it("keeps the Done column on the board when it is empty, until the user hides it", async () => {
  seed();
  await render();
  expect(container.querySelector('[aria-label="Done issues"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="To Do issues"]')).toBeNull();
  act(() => button("Hide Done column").click());
  expect(container.querySelector('[aria-label="Done issues"]')).toBeNull();
  expect(container.querySelector(".it-hidden-columns")?.textContent).toContain(
    "Done",
  );
});

it("keeps the Done group header in the list layout when it is empty", async () => {
  seed();
  await render();
  act(() => button("List view").click());
  expect(container.querySelector(".it-list")).not.toBeNull();
  expect(
    container.querySelector('[aria-label="Done issues"] h2')?.textContent,
  ).toBe("Done");
});

it("opens GitHub from the navigation only when the host provides it", async () => {
  await render();
  expect(container.querySelector(".it-sidebar")?.textContent).not.toContain(
    "GitHub",
  );
  const onOpenGithub = vi.fn();
  await act(async () =>
    root.render(
      createElement(IssueTracker, {
        cwd: "/tmp/web",
        recents: [],
        onOpenGithub,
      }),
    ),
  );
  const entry = [
    ...container.querySelectorAll<HTMLButtonElement>(".it-sidebar nav button"),
  ].find((item) => item.textContent === "GitHub")!;
  act(() => entry.click());
  expect(onOpenGithub).toHaveBeenCalledTimes(1);
});

it("locks the agent once the issue has a thread but not before", async () => {
  const issue = seed();
  updateLocalIssue(issue.id, { agent: "codex" });
  await render();
  act(() => button(`Open MC-${issue.number}: Fix clipping`).click());
  expect(
    document.querySelector(".it-model-choice[data-agent-locked]"),
  ).toBeNull();
  expect(
    document.querySelector('[data-testid="agent-locked-hint"]'),
  ).toBeNull();
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  updateLocalIssue(issue.id, { sessionId: "thread" });
  act(() => button(`Open MC-${issue.number}: Fix clipping`).click());
  const locked = document.querySelector(".it-model-choice[data-agent-locked]")!;
  expect(locked.getAttribute("title")).toContain("Archive and recreate");
  expect(
    document.querySelector('[data-testid="agent-locked-hint"]')?.textContent,
  ).toContain("Archive and recreate to switch agents.");
});

it("returns to In Review with Approve available after a failed feedback run", async () => {
  const issue = reviewed();
  const launch = vi.fn(async (_issue: LocalIssue) => {
    throw new Error("Provider offline");
  });
  await render(launch);
  act(() => button(`Open MC-${issue.number}: Fix clipping`).click());
  act(() =>
    type(
      document.querySelector<HTMLTextAreaElement>(
        '[aria-label="Add issue detail"]',
      )!,
      "Please adjust spacing",
    ),
  );
  await act(async () => buttonByText("Send feedback and iterate")!.click());
  expect(launch).toHaveBeenCalledTimes(1);
  expect(loadLocalIssues()[0]).toMatchObject({
    status: "in_review",
    runState: "failed",
    runError: "Provider offline",
  });
  expect(buttonByText("Approve and commit")).toBeDefined();
  expect(buttonByText("Retry agent")).toBeDefined();
});

it("shows the latest work review as primary with the commit result beside it", async () => {
  const issue = reviewed({
    status: "done",
    runKind: "commit",
    reviews: [
      {
        id: "work",
        text: "Work summary",
        at: new Date(2026, 0, 1).toISOString(),
        kind: "work",
      },
      {
        id: "commit",
        text: "Committed abc1234",
        at: new Date(2026, 0, 2).toISOString(),
        kind: "commit",
      },
    ],
  });
  await render();
  act(() => button(`Open MC-${issue.number}: Fix clipping`).click());
  const review = document.querySelector(".it-review")!;
  expect(review.textContent).toContain("Work summary");
  expect(review.querySelector(".it-commit")?.textContent).toContain(
    "Committed",
  );
  expect(review.querySelector(".it-commit")?.textContent).toContain(
    "Committed abc1234",
  );
});

it("picks a status with its number hint", async () => {
  const issue = seed();
  await render();
  act(() => button(`Change status for MC-${issue.number}`).click());
  const search = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search change status for mc-1"]',
  )!;
  act(() => {
    search.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "4",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(loadLocalIssues()[0].status).toBe("in_review");
});

it("checks the active sort, remembers it, and collapses sidebar sections", async () => {
  seed();
  await render();
  act(() => button("Display options").click());
  const item = (label: string) =>
    [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ].find((entry) => entry.textContent?.includes(label))!;
  expect(item("Newest first").getAttribute("aria-checked")).toBe("true");
  expect(item("Show empty groups").getAttribute("aria-checked")).toBe("false");
  act(() => item("Oldest first").click());
  expect(localStorage.getItem("monocode.issues.sort")).toBe("oldest");
  act(() => button("Display options").click());
  expect(item("Oldest first").getAttribute("aria-checked")).toBe("true");
  expect(item("Newest first").getAttribute("aria-checked")).toBe("false");
  act(() =>
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  const heading = [
    ...container.querySelectorAll<HTMLButtonElement>(".it-sidebar-heading"),
  ].find((entry) => entry.textContent === "Your projects")!;
  expect(heading.getAttribute("aria-expanded")).toBe("true");
  act(() => heading.click());
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(
    container.querySelector(".it-project-nav")?.hasAttribute("hidden"),
  ).toBe(true);
});

it("cannot create an issue directly in the agent-owned In Progress status", async () => {
  await render();
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true }),
    ),
  );
  expect(
    container.querySelector('[aria-label="Create issue in In Progress"]'),
  ).toBeNull();
  act(() =>
    (
      document.querySelector('[aria-label="Change status"]') as HTMLElement
    ).click(),
  );
  const labels = [...document.querySelectorAll('[role="menuitemradio"]')].map(
    (entry) => entry.textContent,
  );
  expect(labels.some((label) => label?.includes("In Progress"))).toBe(false);
  expect(labels.some((label) => label?.includes("To Do"))).toBe(true);
});
