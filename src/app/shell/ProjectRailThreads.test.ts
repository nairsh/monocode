// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import { setSessionArchived, upsertSession } from "../../features/sessions/data/sessionStore";
import { newSession } from "../../features/sessions/model/session";
import { takeOpenIssueRequest } from "../../features/inbox/model/issueReference";
import { createLocalIssue, updateLocalIssue } from "../../features/inbox/model/localIssues";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { listSessionsByProject } = vi.hoisted(() => ({
  listSessionsByProject: vi.fn(),
}));

vi.mock("../../features/sessions/data/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/sessions/data/sessionStore")
  >()),
  listSessionsByProject,
}));
vi.mock("../../features/source-control/hooks/useProjectDiffStats", () => ({
  useProjectDiffStats: () => null,
}));
vi.mock("../../features/source-control/hooks/useGitFileStatuses", () => ({
  useGitFileStatuses: () => ({ files: new Map(), dirs: new Map() }),
}));
vi.mock("./SidebarUpdate", () => ({ SidebarUpdateFooter: () => null }));
vi.mock("../../features/files/ui/FileTree", () => ({ FileTree: () => null }));

let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof Sidebar>;

const chat = (id: string, cwd: string, updatedAt: number): SessionSummary => ({
  id,
  cwd,
  harness: "claude",
  model: "",
  runtimeMode: "supervised",
  title: `Chat ${id}`,
  createdAt: updatedAt,
  updatedAt,
});

const chatList = (project: string) =>
  container.querySelector(`ul[aria-label="${project} chats"]`);
const collapsed = (project: string) =>
  !!chatList(project)?.closest("[inert]");
const chatButtons = (project: string) =>
  [...(chatList(project)?.querySelectorAll("li > button") ?? [])].filter(
    (button) => button.textContent !== "Show more" && !button.hasAttribute("aria-haspopup"),
  );
const header = (project: string) =>
  container.querySelector<HTMLElement>(
    `[aria-expanded] button[aria-label^="${project}"]`,
  )!;

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockRejectedValue(new Error("Not running in Tauri"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  listSessionsByProject.mockReset();
  listSessionsByProject.mockResolvedValue([chat("other-1", "/work/other", 5)]);
  props = {
    cwd: "/work/project",
    open: true,
    sessions: Array.from({ length: 7 }, (_, index) =>
      chat(`c${index}`, "/work/project", 100 - index),
    ),
    busySessionIds: new Set(),
    approvalSessionIds: new Set(),
    activeSessionId: "c0",
    status: "idle",
    pending: false,
    tab: "sessions",
    filesSearchOpen: false,
    onSelectSession: vi.fn(),
    onOpenFile: vi.fn(),
    onTabChange: vi.fn(),
    onFilesSearchOpenChange: vi.fn(),
    recents: [
      { path: "/work/project", openedAt: 2 },
      { path: "/work/other", openedAt: 1 },
    ],
    projectRailOpen: true,
    compactProjectRail: false,
    onSelectProject: vi.fn(),
    onOpenProject: vi.fn(),
    onNewInProject: vi.fn(),
    onArchiveSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onRenameSession: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("lists the current project's chats five at a time under its row", async () => {
  await act(async () => root.render(createElement(Sidebar, props)));

  expect(chatButtons("project")).toHaveLength(5);
  expect(chatButtons("project")[0].getAttribute("aria-current")).toBe("true");
  const more = [...chatList("project")!.querySelectorAll("button")].find(
    (button) => button.textContent === "Show more",
  )!;
  await act(async () => more.click());
  expect(chatButtons("project")).toHaveLength(7);

  await act(async () => (chatButtons("project")[3] as HTMLElement).click());
  expect(props.onSelectSession).toHaveBeenCalledWith("c3");
});

it("puts working, approval and unread threads ahead of read threads before pagination", async () => {
  props.sessions = props.sessions.map((session) => ({
    ...session,
    pinned: session.id === "c0",
  }));
  props.busySessionIds = new Set(["c6"]);
  props.approvalSessionIds = new Set(["c5"]);
  props.unseenFinishedIds = new Set(["c4"]);
  await act(async () => root.render(createElement(Sidebar, props)));

  expect(chatButtons("project").map((button) => button.querySelector(".font-medium")?.textContent)).toEqual([
    "Chat c4", "Chat c5", "Chat c6", "Chat c0", "Chat c1",
  ]);
});

it("moves an opened unread thread below threads still needing attention", async () => {
  props.busySessionIds = new Set(["c4", "c6"]);
  await act(async () => root.render(createElement(Sidebar, props)));
  props.busySessionIds = new Set(["c6"]);
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project")[0].getAttribute("aria-label")).toBe("Chat c4, Finished");

  await act(async () => (chatButtons("project")[0] as HTMLElement).click());
  expect(props.onSelectSession).toHaveBeenCalledWith("c4");
  props.activeSessionId = "c4";
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project").map((button) => button.querySelector(".font-medium")?.textContent)).toEqual([
    "Chat c6", "Chat c0", "Chat c1", "Chat c2", "Chat c3",
  ]);

  const more = [...chatList("project")!.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Show more")!;
  await act(async () => more.click());
  const opened = chatButtons("project")[5];
  expect(opened.getAttribute("aria-current")).toBe("true");
  expect(opened.getAttribute("aria-label")).toBe("Chat c4");
});

it("keeps an opened thread near the top while it is still working or awaiting approval", async () => {
  props.activeSessionId = "c6";
  props.busySessionIds = new Set(["c6"]);
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project")[0].querySelector(".font-medium")?.textContent).toBe("Chat c6");
  expect(chatButtons("project")[0].getAttribute("aria-current")).toBe("true");

  props.busySessionIds = new Set();
  props.approvalSessionIds = new Set(["c6"]);
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project")[0].getAttribute("aria-label")).toBe("Chat c6, Needs approval");
});

it("prioritizes unread threads in another expanded project", async () => {
  listSessionsByProject.mockResolvedValue([
    chat("other-1", "/work/other", 5),
    chat("other-2", "/work/other", 1),
  ]);
  props.unseenFinishedIds = new Set(["other-2"]);
  await act(async () => root.render(createElement(Sidebar, props)));
  await act(async () => header("other").click());
  expect(chatButtons("other").map((button) => button.querySelector(".font-medium")?.textContent)).toEqual([
    "Chat other-2", "Chat other-1",
  ]);

  props.unseenFinishedIds = new Set();
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("other").map((button) => button.querySelector(".font-medium")?.textContent)).toEqual([
    "Chat other-1", "Chat other-2",
  ]);
});

it("does not reload other projects or measure unchanged rows during live updates", async () => {
  await act(async () => root.render(createElement(Sidebar, props)));
  await act(async () => header("other").click());
  listSessionsByProject.mockClear();
  const offset = vi.spyOn(HTMLElement.prototype, "offsetTop", "get");
  try {
    for (let index = 0; index < 30; index++) {
      props.sessions = props.sessions.slice();
      await act(async () => root.render(createElement(Sidebar, props)));
    }
    expect(listSessionsByProject).not.toHaveBeenCalled();
    expect(offset).not.toHaveBeenCalled();
    expect(chatButtons("other")[0].querySelector(".font-medium")?.textContent).toBe("Chat other-1");
  } finally {
    offset.mockRestore();
  }
});

it("refreshes other projects after a successful write, but not failed or unrelated writes", async () => {
  await act(async () => root.render(createElement(Sidebar, props)));
  await act(async () => header("other").click());
  listSessionsByProject.mockClear();
  const session = newSession("claude", "/work/project");
  session.blocks = [{ id: "u", role: "user", text: "Hello" }];
  vi.mocked(invoke).mockResolvedValue(chat(session.id, session.cwd, 1));
  await act(async () => { await upsertSession(session); });
  expect(listSessionsByProject).not.toHaveBeenCalled();

  vi.mocked(invoke).mockRejectedValueOnce(new Error("Disk busy"));
  await act(async () => {
    await expect(setSessionArchived("other-1", true)).rejects.toThrow("Disk busy");
  });
  expect(listSessionsByProject).not.toHaveBeenCalled();

  listSessionsByProject.mockResolvedValue([]);
  vi.mocked(invoke).mockResolvedValue(undefined);
  await act(async () => { await setSessionArchived("other-1", true); });
  expect(listSessionsByProject).toHaveBeenCalledOnce();
  expect(chatButtons("other")).toHaveLength(0);
});

it.each([false, true])("slides reordered rows while respecting reduced motion (%s)", async (reducedMotion) => {
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  const offset = vi.spyOn(HTMLElement.prototype, "offsetTop", "get")
    .mockImplementation(function (this: HTMLElement) {
      return [...(this.parentElement?.children ?? [])].indexOf(this) * 29;
    });
  const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: reducedMotion } as MediaQueryList);
  document.documentElement.style.setProperty("--motion-reorder-duration", "160ms");
  try {
    props.sessions = props.sessions.slice(0, 2);
    props.unseenFinishedIds = new Set(["c1"]);
    await act(async () => root.render(createElement(Sidebar, props)));
    expect(animate).not.toHaveBeenCalled();

    props.unseenFinishedIds = new Set();
    await act(async () => root.render(createElement(Sidebar, props)));
    if (reducedMotion) {
      expect(animate).not.toHaveBeenCalled();
    } else {
      expect(animate).toHaveBeenCalledWith([
        { transform: "translateY(29px)" }, { transform: "translateY(0)" },
      ], { duration: 160, easing: "linear" });
      expect(animate).toHaveBeenCalledWith([
        { transform: "translateY(-29px)" }, { transform: "translateY(0)" },
      ], { duration: 160, easing: "linear" });
      await act(async () => root.render(null));
      expect(cancel).toHaveBeenCalledTimes(2);
    }
  } finally {
    offset.mockRestore();
    media.mockRestore();
    document.documentElement.style.removeProperty("--motion-reorder-duration");
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("collapses and expands a project's chats from its row", async () => {
  await act(async () => root.render(createElement(Sidebar, props)));

  await act(async () => header("project").click());
  expect(collapsed("project")).toBe(true);
  expect(props.onSelectProject).not.toHaveBeenCalled();

  expect(collapsed("other")).toBe(true);
  await act(async () => header("other").click());
  expect(collapsed("other")).toBe(false);
  expect(listSessionsByProject).toHaveBeenCalledWith("/work/other");
  expect(chatButtons("other").map((button) => button.querySelector(".font-medium")?.textContent)).toEqual([
    "Chat other-1",
  ]);
});

it("starts a chat in a project and drops the Sessions tab from the workspace", async () => {
  await act(async () => root.render(createElement(Sidebar, props)));

  const newChat = container.querySelector<HTMLButtonElement>(
    'button[aria-label="New chat in other"]',
  )!;
  await act(async () => newChat.click());
  expect(props.onNewInProject).toHaveBeenCalledWith("/work/other");

  const tabs = [...container.querySelectorAll('[role="tab"]')].map(
    (tab) => tab.textContent,
  );
  expect(tabs).not.toContain("Sessions");
  expect(tabs).toContain("Explorer");
});

it.each([
  ["project", "c0", "Archive", "onArchiveSession"],
  ["project", "c1", "Delete", "onDeleteSession"],
  ["other", "other-1", "Archive", "onArchiveSession"],
  ["other", "other-1", "Delete", "onDeleteSession"],
] as const)("opens %s thread actions and routes %s %s to its handler", async (project, sessionId, action, handler) => {
  await act(async () => root.render(createElement(Sidebar, props)));
  if (project === "other") await act(async () => header("other").click());

  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for Chat ${sessionId}"]`,
  )!;
  await act(async () => trigger.click());
  expect(props.onSelectSession).not.toHaveBeenCalled();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent === action)!;
  await act(async () => item.click());
  if (action === "Archive") expect(props[handler]).toHaveBeenCalledWith(sessionId, true);
  else expect(props[handler]).toHaveBeenCalledWith(sessionId);
  expect(document.querySelector('[role="menu"][aria-label="Thread actions"]')).toBeNull();
});

it.each(["project", "other"])("renames a thread in %s through its actions menu", async (project) => {
  await act(async () => root.render(createElement(Sidebar, props)));
  if (project === "other") await act(async () => header("other").click());
  const sessionId = project === "other" ? "other-1" : "c0";
  const trigger = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Actions for Chat ${sessionId}"]`,
  )!;
  await act(async () => trigger.click());
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.startsWith("Rename"))!;
  await act(async () => item.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Rename thread"]')!;
  expect(document.activeElement).toBe(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "  Renamed thread  ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(props.onRenameSession).toHaveBeenCalledExactlyOnceWith(sessionId, "Renamed thread");
  expect(props.onSelectSession).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Rename thread"]')).toBeNull();
});

it("cancels a thread rename with Escape", async () => {
  await act(async () => root.render(createElement(Sidebar, props)));
  await act(async () => chatButtons("project")[0].dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })));
  const input = container.querySelector<HTMLInputElement>('[aria-label="Rename thread"]')!;
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(props.onRenameSession).not.toHaveBeenCalled();
  expect(container.querySelector('[aria-label="Rename thread"]')).toBeNull();
});

it("docks the workspace panel on the right beside the rail and collapses it there", async () => {
  const slot = document.createElement("div");
  document.body.append(slot);
  const tablist = '[role="tablist"][aria-label="Workspace"]';
  await act(async () =>
    root.render(createElement(Sidebar, { ...props, rightSlot: slot })),
  );
  expect(slot.querySelector(tablist)).not.toBeNull();
  expect(container.querySelector(tablist)).toBeNull();

  await act(async () =>
    root.render(
      createElement(Sidebar, { ...props, rightSlot: slot, open: false }),
    ),
  );
  expect(slot.firstElementChild?.hasAttribute("inert")).toBe(true);
  slot.remove();
});


it("shows the model used by each thread alongside its title", async () => {
  props.sessions = props.sessions.map((session, index) => ({
    ...session,
    harness: index === 0 ? "codex" : "claude",
    model: index === 0 ? "gpt-5.4" : "claude-opus-4-6",
  }));
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project")[0].textContent).toContain("GPT-5.4");
  expect(chatButtons("project")[1].textContent).toContain("Opus");
});

it("does not claim the current project has no chats while its first listing is pending", async () => {
  props.sessions = [];
  props.pending = true;
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatList("project")?.textContent).not.toContain("No chats yet");

  props.pending = false;
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatList("project")?.textContent).toContain("No chats yet");
});

it("keeps a project's chats listed while its stored list loads after switching away", async () => {
  let resolve!: (rows: SessionSummary[]) => void;
  listSessionsByProject.mockReturnValue(new Promise<SessionSummary[]>((done) => { resolve = done; }));
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project")).toHaveLength(5);

  props.cwd = "/work/other";
  props.sessions = [chat("other-1", "/work/other", 5)];
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project")).toHaveLength(5);
  expect(chatList("project")?.textContent).not.toContain("No chats yet");

  await act(async () => resolve([chat("c0", "/work/project", 100)]));
  expect(chatButtons("project")).toHaveLength(1);
});

it("tags a thread that belongs to an issue and opens that issue from the tag", async () => {
  const created = createLocalIssue({
    title: "Fix it", description: "", status: "backlog", priority: 2, projectPath: "/work/project", labels: [], agent: "",
  });
  updateLocalIssue(created.id, { sessionId: "c1" });
  await act(async () => root.render(createElement(Sidebar, props)));
  expect(chatButtons("project")[0].querySelector('[role="link"]')).toBeNull();
  const tag = chatButtons("project")[1].querySelector<HTMLElement>('[role="link"]')!;
  expect(tag.textContent).toContain(`MC-${created.number}`);

  await act(async () => tag.click());
  expect(takeOpenIssueRequest()).toBe(created.number);
  expect(props.onSelectSession).not.toHaveBeenCalled();
});

it("starts a new thread from the button above Search", async () => {
  props.onNew = vi.fn();
  await act(async () => root.render(createElement(Sidebar, props)));
  const button = container.querySelector<HTMLElement>('nav[aria-label="Projects"] button[aria-label^="New thread"]')!;
  expect(button.nextElementSibling?.nextElementSibling?.getAttribute("aria-label")).toContain("Search");
  await act(async () => button.click());
  expect(props.onNew).toHaveBeenCalledOnce();
});
