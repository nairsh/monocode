// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { applyTriagePlan } from "./issueTriage";
import {
  dispatchQueuedIssueGroups,
  queueIssueGroups,
  watchIssueQueue,
} from "./issueQueue";
import {
  createLocalIssue,
  issueAssignment,
  loadLocalIssues,
  moveLocalIssue,
  updateIssueAssignment,
  updateLocalIssue,
  type LocalIssue,
} from "./localIssues";

beforeEach(() => localStorage.clear());

function seedGroups() {
  const issues = ["A", "B", "C", "D"].map((title) =>
    createLocalIssue({
      title,
      description: title,
      projectPath: "/repo",
      status: "backlog",
      priority: 0,
      labels: [],
      agent: "",
    }),
  );
  const [a, b, c, d] = issues;
  applyTriagePlan({
    snapshot: issues,
    plan: {
      groups: [
        { title: "A", reason: "Separate work", files: [], issueIds: [a.id] },
        { title: "B", reason: "Separate work", files: [], issueIds: [b.id] },
        {
          title: "C and D",
          reason: "Shared work",
          files: [],
          issueIds: [c.id, d.id],
        },
      ],
      dependencies: [
        { issueId: c.id, dependsOn: a.id, reason: "Needs A" },
        { issueId: c.id, dependsOn: b.id, reason: "Needs B" },
        { issueId: d.id, dependsOn: c.id, reason: "Internal order" },
      ],
    },
  });
  return issues;
}

function runningLaunch() {
  return vi.fn(async (issue: LocalIssue) => {
    updateIssueAssignment(issue, {
      sessionId: `thread-${issue.id}`,
      worktreeCwd: `/trees/${issue.runBatchId}`,
      runState: "running",
      status: "in_progress",
    });
  });
}

it("launches independent groups in parallel and waits for every approved prerequisite commit", async () => {
  const [a, b, c, d] = seedGroups();
  queueIssueGroups([a.id, b.id, c.id]);
  expect(
    loadLocalIssues().every(
      (issue) => issue.status === "todo" && issue.dispatchQueued,
    ),
  ).toBe(true);
  const launch = runningLaunch();
  const error = vi.fn();
  await dispatchQueuedIssueGroups(launch, error);
  expect(launch.mock.calls.map(([issue]) => issue.id)).toEqual([a.id, b.id]);
  expect(
    loadLocalIssues().filter((issue) => issue.runState === "running"),
  ).toHaveLength(2);
  updateLocalIssue(a.id, { status: "in_review", runState: "completed" });
  await dispatchQueuedIssueGroups(launch, error);
  expect(launch).toHaveBeenCalledTimes(2);
  updateLocalIssue(a.id, { status: "done", commitSha: "a".repeat(40) });
  await dispatchQueuedIssueGroups(launch, error);
  expect(launch).toHaveBeenCalledTimes(2);
  updateLocalIssue(b.id, {
    status: "done",
    commitSha: "b".repeat(40),
    runState: "completed",
  });
  await dispatchQueuedIssueGroups(launch, error);
  expect(launch).toHaveBeenCalledTimes(3);
  expect(
    issueAssignment(loadLocalIssues().find((issue) => issue.id === c.id)!).map(
      (issue) => issue.id,
    ),
  ).toEqual([c.id, d.id]);
  expect(
    loadLocalIssues().find((issue) => issue.id === d.id)?.triageDependencies,
  ).toEqual([c.id]);
  expect(error).not.toHaveBeenCalled();
});

it("dispatches a dragged group once even with two queue watchers and resumes blocked groups on a store change", async () => {
  const [a, b, c] = seedGroups();
  const launch = runningLaunch();
  const error = vi.fn();
  const stop = [watchIssueQueue(launch, error), watchIssueQueue(launch, error)];
  try {
    await moveLocalIssue(c.id, "todo");
    await dispatchQueuedIssueGroups(launch, error);
    expect(launch).not.toHaveBeenCalled();
    await moveLocalIssue(a.id, "todo");
    await moveLocalIssue(b.id, "todo");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    updateLocalIssue(a.id, {
      status: "done",
      commitSha: "a".repeat(40),
      runState: "completed",
    });
    updateLocalIssue(b.id, {
      status: "done",
      commitSha: "b".repeat(40),
      runState: "completed",
    });
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(3));
    expect(error).not.toHaveBeenCalled();
  } finally {
    stop.forEach((unsubscribe) => unsubscribe());
  }
});

it("keeps failed launches out of the queue until the user retries", async () => {
  const [a] = seedGroups();
  queueIssueGroups([a.id]);
  const launch = vi.fn(async () => {
    throw new Error("Provider unavailable");
  });
  const error = vi.fn();
  await dispatchQueuedIssueGroups(launch, error);
  await dispatchQueuedIssueGroups(launch, error);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(loadLocalIssues()[0]).toMatchObject({
    status: "todo",
    runState: "failed",
    runError: "Provider unavailable",
  });
  expect(error).toHaveBeenCalledTimes(1);
});

it("cancels a queued request when the issue moves back to Backlog", async () => {
  const [a] = seedGroups();
  await moveLocalIssue(a.id, "todo");
  await moveLocalIssue(a.id, "backlog");
  const launch = runningLaunch();
  await dispatchQueuedIssueGroups(launch, vi.fn());
  expect(launch).not.toHaveBeenCalled();
  expect(loadLocalIssues()[0].dispatchQueued).toBeUndefined();
});
