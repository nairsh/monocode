import { afterEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../model/session";
import { historyWithLiveSessions, summaryFromSession } from "./sessionHistory";
import { SidebarSessionSummaries } from "./sidebarSessionSummaries";
import type { SessionSummary } from "./sessionStore";
import type { OrchestrationRun } from "../../orchestration/model/orchestration";

const cwd = "/tmp/sidebar-project";
const git = { branch: "main", repo: "sidebar-project" };
const runs: OrchestrationRun[] = [];
function chat(): Session {
  return { ...newSession("codex", cwd), busy: true, blocks: [
    { id: "user", role: "user", text: "hello" },
    { id: "answer", role: "assistant", text: "a" },
  ] };
}
afterEach(() => vi.restoreAllMocks());

describe("sidebar summary publication", () => {
  it("does no summary/timestamp work for thirty text-only updates", () => {
    const cache = new SidebarSessionSummaries();
    const history: SessionSummary[] = [];
    let session = chat();
    const first = cache.update(history, [session], cwd, git, runs);
    const clock = vi.spyOn(Date, "now");
    for (let chunk = 0; chunk < 30; chunk++) {
      session = { ...session, blocks: [session.blocks[0], {
        ...session.blocks[1], text: "a".repeat(chunk + 2),
      }] };
      expect(cache.update(history, [session], cwd, { ...git }, runs)).toBe(first);
    }
    expect(clock).not.toHaveBeenCalled();
  });

  it("preserves the busy-chat short circuit instead of scanning approvals", () => {
    const session = chat();
    const approvalReads = vi.fn(() => undefined);
    Object.defineProperty(session.blocks[1], "approval", { get: approvalReads });
    const cache = new SidebarSessionSummaries();
    const history: SessionSummary[] = [];
    cache.update(history, [session], cwd, git, runs);
    cache.update(history, [{ ...session }], cwd, git, runs);
    expect(approvalReads).not.toHaveBeenCalled();
  });

  it.each([
    ["title", { title: "renamed" }],
    ["model", { model: "new-model" }],
    ["runtime", { runtimeMode: "autonomous" }],
    ["project", { cwd: "/tmp/other" }],
    ["hidden", { sidebarHidden: true }],
    ["worktree", { worktreeCwd: "/tmp/worktree", branch: "feature" }],
    ["removed worktree", { worktreeRemoved: true }],
    ["automation", { automationId: "automation" }],
    ["linked work item", { linkedWorkItem: { kind: "pr", repo: "acme/app", number: 42,
      url: "https://github.com/acme/app/pull/42" } }],
    ["worker", { orchestrationLeadId: "lead" }],
    ["ephemeral", { ephemeral: true }],
    ["finished", { busy: false }],
    ["draft", { blocks: [{ id: "draft", role: "user", text: "draft", draft: true }] }],
    ["empty", { busy: false, blocks: [] }],
  ] as [string, Partial<Session>][]) ("publishes a %s change with existing projection rules", (_label, change) => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const history: SessionSummary[] = [];
    const session = chat();
    const cache = new SidebarSessionSummaries();
    const before = cache.update(history, [session], cwd, git, runs);
    const next = { ...session, ...change };
    const actual = cache.update(history, [next], cwd, git, runs);
    expect(actual).not.toBe(before);
    expect(actual.history).toEqual(historyWithLiveSessions(
      history, [next].filter((value) => !value.ephemeral), cwd, git, runs,
    ));
    expect(actual.open).toEqual(
      !next.ephemeral && !next.orchestrationLeadId && next.cwd === cwd
        ? [summaryFromSession(next, git)] : [],
    );
  });

  it("publishes saved timestamps, pin/archive changes, membership and git changes", () => {
    const cache = new SidebarSessionSummaries();
    const session = chat();
    let history = [summaryFromSession(session)];
    let result = cache.update(history, [session], cwd, git, runs);
    history = [{ ...history[0], updatedAt: 42, pinned: true, archived: true }];
    const saved = cache.update(history, [session], cwd, git, runs);
    expect(saved).not.toBe(result);
    expect(saved.history[0]).toMatchObject({ updatedAt: 42, pinned: true, archived: true });
    result = cache.update(history, [session], cwd, { ...git, branch: "new" }, runs);
    expect(result).not.toBe(saved);
    expect(result.open[0].branch).toBe("new");
    expect(cache.update(history, [], cwd, git, runs).open).toEqual([]);
  });

  it("publishes approval/question changes even when a worker's answer also streams", () => {
    const cache = new SidebarSessionSummaries();
    const session = { ...chat(), orchestrationLeadId: "lead" };
    const history = [{ ...summaryFromSession(session), id: "lead", orchestrationLeadId: undefined }];
    const workerRuns: OrchestrationRun[] = [{
      version: 1, leadId: "lead", cwd, status: "active", allowedHarnesses: ["codex"],
      maxWorkers: 1, cli: "monocode", continuations: 0, requests: {},
      tasks: [{ id: "task", sessionId: session.id, title: "worker", harness: "codex",
        model: session.model, prompt: "work", files: [], scopes: [], dependsOn: [],
        status: "running", accepted: false, result: "", delivered: false }],
    }];
    const before = cache.update(history, [session], cwd, git, workerRuns);
    const waiting = { ...session, pendingQuestion: { requestId: 1, questions: [] } };
    const waitingResult = cache.update(history, [waiting], cwd, git, workerRuns);
    expect(waitingResult).not.toBe(before);
    expect(waitingResult.history[0].orchestration?.tasks[0].needsInput).toBe(true);
    expect(cache.update(history, [{ ...waiting, blocks: [
      ...waiting.blocks, { id: "more", role: "assistant", text: "more" },
    ] }], cwd, git, workerRuns)).toBe(waitingResult);
    const finished = cache.update(history, [session], cwd, git, workerRuns);
    expect(finished.history[0].orchestration?.tasks[0].needsInput).toBe(false);
    const hidden = cache.update(history, [{ ...waiting, ephemeral: true }], cwd, git, workerRuns);
    expect(hidden.history[0].orchestration?.tasks[0].needsInput).toBe(false);
    expect(cache.update(history, [session], cwd, git, [...workerRuns])).not.toBe(finished);
  });
});
