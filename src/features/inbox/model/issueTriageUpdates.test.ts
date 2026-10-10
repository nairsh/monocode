// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  applyTriagePlan,
  startIssueSelection,
  triageBacklog,
  undoTriage,
  type TriagePlan,
} from "./issueTriage";
import {
  createLocalIssue,
  loadLocalIssues,
  updateLocalIssue,
  type LocalIssue,
} from "./localIssues";
import { runTriageAgent } from "./triageAgent";
vi.mock("./triageAgent", () => ({ runTriageAgent: vi.fn() }));
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
});
const seed = (projectPath = "/repo", parentIssueId?: string) =>
  createLocalIssue({
    title: "Original",
    description: "Original scope",
    priority: 0,
    labels: [],
    status: "backlog",
    agent: "",
    projectPath,
    parentIssueId,
  });
const plan = (issues: LocalIssue[]): TriagePlan => ({
  groups: [
    {
      title: "Topic",
      reason: "Shared context",
      files: ["src/app.ts"],
      issueIds: issues.map((issue) => issue.id),
    },
  ],
  dependencies: [],
  updates: issues.map((issue) => ({
    issueId: issue.id,
    description: "Refined scope",
    priority: 2,
    reason: "Clarify task",
  })),
});

it("rejects unscoped, duplicate and invalid priority updates atomically", () => {
  const issue = seed();
  const other = seed();
  for (const updates of [
    [{ issueId: other.id, priority: 2, reason: "Out of scope" }],
    [{ issueId: issue.id, priority: 9, reason: "Invalid" }],
    [{ issueId: issue.id, title: "", reason: "Empty" }],
    [plan([issue]).updates![0], plan([issue]).updates![0]],
  ]) {
    expect(() =>
      applyTriagePlan({
        snapshot: [issue],
        plan: { ...plan([issue]), updates },
      }),
    ).toThrow();
    expect(loadLocalIssues()[0]).toEqual(issue);
  }
});

it("applies successful repositories as they complete and retains undo after a later failure", async () => {
  const a = seed();
  const b = seed("/other");
  vi.mocked(runTriageAgent).mockImplementation(async ({ issues }) => {
    if (issues[0].id === b.id) {
      expect(loadLocalIssues()[0].description).toBe("Refined scope");
      throw new Error("Provider disconnected");
    }
    return plan(issues);
  });
  const receipts: ReturnType<typeof applyTriagePlan>[] = [];
  const result = await triageBacklog(undefined, {
    onBatch: (batch) => {
      receipts.push(applyTriagePlan(batch));
    },
  });
  expect(result.warnings?.join(" ")).toContain("Provider disconnected");
  expect(loadLocalIssues()[1]).toEqual(b);
  expect(undoTriage(receipts)).toBe(1);
  expect(loadLocalIssues()[0].description).toBe(a.description);
});

it("does not overwrite an issue edited during triage", async () => {
  const a = seed();
  vi.mocked(runTriageAgent).mockImplementation(async ({ issues }) => {
    updateLocalIssue(a.id, { description: "User edit" });
    return plan(issues);
  });
  await expect(
    triageBacklog(undefined, { onBatch: applyTriagePlan }),
  ).rejects.toThrow("changed during triage");
  expect(loadLocalIssues()[0].description).toBe("User edit");
  expect(loadLocalIssues()[0].triageGroup).toBeUndefined();
});

it("undo preserves later priority edits and skips issues which already started", () => {
  const a = seed();
  const b = seed();
  const receipt = applyTriagePlan({ snapshot: [a, b], plan: plan([a, b]) });
  updateLocalIssue(a.id, { priority: 1 });
  updateLocalIssue(b.id, { sessionId: "started", runState: "running" });
  expect(undoTriage([receipt])).toBe(1);
  expect(loadLocalIssues()[0].priority).toBe(1);
  expect(loadLocalIssues()[1].triageGroup).toBeDefined();
});

it("starts a priority selection in one thread and refuses mixed projects", async () => {
  const a = seed();
  const b = seed();
  const other = seed("/other");
  const launch = vi.fn(async () => {});
  await expect(
    startIssueSelection("High", [a.id, other.id], launch),
  ).rejects.toThrow("span projects");
  expect(loadLocalIssues()[0].triageGroup).toBeUndefined();
  await startIssueSelection("High", [a.id, b.id], launch);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(loadLocalIssues()[0].runBatchId).toBe(loadLocalIssues()[1].runBatchId);
});

it("validates sub-issue parents, projects and cycles", () => {
  const parent = seed();
  const child = seed("/repo", parent.id);
  expect(() =>
    updateLocalIssue(parent.id, { parentIssueId: child.id }),
  ).toThrow("cycle");
  expect(() => seed("/other", parent.id)).toThrow("same project");
  expect(() => seed("/repo", "missing")).toThrow("same project");
  expect(loadLocalIssues()).toHaveLength(2);
});
