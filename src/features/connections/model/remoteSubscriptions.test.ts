import { afterEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { loadRemoteSession, waitForRemoteSession } from "./connections";
import type { HostSession } from "./protocol";
afterEach(() => vi.clearAllMocks());

it("shares one machine request across panes and resumes only changed revisions", async () => {
  let reply!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
  invoke.mockResolvedValueOnce({ b: 3 });
  const a = new AbortController(), b = new AbortController();
  const first = waitForRemoteSession("shared-machine", "a", 1, a.signal);
  const second = waitForRemoteSession("shared-machine", "b", 2, b.signal);
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][1].params.cursors).toEqual([
    { sessionId: "a", revision: 1 }, { sessionId: "b", revision: 2 },
  ]);
  reply({ a: 2 });
  await first;
  await second;
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("deduplicates identical syncs and releases aborted pane waits", async () => {
  const value: HostSession = { projectId: "p", revision: 1, status: "idle", updatedAt: 1,
    session: { id: "s", harness: "codex", model: "codex:test", runtimeMode: "supervised", cwd: "/repo", title: "Chat", blocks: [] } };
  invoke.mockResolvedValueOnce({ kind: "snapshot", value });
  const [a, b] = await Promise.all([loadRemoteSession("machine", "s"), loadRemoteSession("machine", "s")]);
  expect(a).toBe(b);
  expect(invoke).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const wait = waitForRemoteSession("cancelled-machine", "s", 1, controller.signal);
  controller.abort();
  await wait;
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("wakes an existing machine wait when a new pane arrives", async () => {
  let finish!: (result: unknown) => void;
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  invoke.mockImplementation((_command, input) => {
    requests.push(input);
    if (input.method === "sessions.wake") { finish({}); return Promise.resolve({ awake: true }); }
    if (requests.filter((request) => request.method === "sessions.wait").length === 1)
      return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve({ second: 2 });
  });
  const firstController = new AbortController(), secondController = new AbortController();
  const first = waitForRemoteSession("new-pane", "first", 1, firstController.signal);
  await Promise.resolve();
  const second = waitForRemoteSession("new-pane", "second", 1, secondController.signal);
  await first;
  await second;
  expect(requests.map((request) => request.method)).toEqual(["sessions.wait", "sessions.wake", "sessions.wait"]);
  expect(requests[2].params.cursors).toEqual([{ sessionId: "second", revision: 1 }]);
});

it("shares transport responses while applying each pane's own immutable base", async () => {
  const a: HostSession = { projectId: "p", revision: 5, status: "idle", updatedAt: 1,
    session: { id: "same-session", harness: "codex", model: "codex:test", runtimeMode: "supervised", cwd: "/repo", title: "Chat", blocks: [] } };
  const b = { ...a, session: { ...a.session, title: "Pane-local base" } };
  invoke.mockResolvedValueOnce({ kind: "unchanged", revision: 5 });
  const results = await Promise.all([loadRemoteSession("base-machine", "same-session", a), loadRemoteSession("base-machine", "same-session", b)]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(results[0]).toBe(a);
  expect(results[1]).toBe(b);
});

it("rotates subscription batches beyond the bounded 64-session host request", async () => {
  invoke.mockResolvedValueOnce({ "session-0": 2 });
  invoke.mockResolvedValue({});
  const waits = Array.from({ length: 70 }, (_, index) => waitForRemoteSession("wide-machine", `session-${index}`, 1, new AbortController().signal));
  await Promise.all(waits);
  const requests = invoke.mock.calls.filter((call) => call[1].method === "sessions.wait");
  expect(requests).toHaveLength(2);
  expect(requests[0][1].params.cursors).toHaveLength(64);
  expect(requests[1][1].params.cursors.slice(0, 6).map((cursor: { sessionId: string }) => cursor.sessionId))
    .toEqual(Array.from({ length: 6 }, (_, index) => `session-${index + 64}`));
});
