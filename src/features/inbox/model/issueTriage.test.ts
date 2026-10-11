// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { runTriageAgent } from "./triageAgent";
import {
  applyTriagePlan,
  detachUnstartedIssue,
  loadTriageDraft,
  saveTriageDraft,
  startIssueGroup,
  triageBacklog,
  validateTriagePlan,
  type TriagePlan,
} from "./issueTriage";
import {
  createLocalIssue,
  issueAssignment,
  issueBlockers,
  loadLocalIssues,
  localIssueAssignmentPrompt,
  moveLocalIssue,
  parseIssueOutcomes,
  startLocalIssue,
  updateIssueAssignment,
  updateLocalIssue,
  updateLocalIssues,
  type LocalIssue,
} from "./localIssues";

vi.mock("./triageAgent", () => ({ runTriageAgent: vi.fn() }));
beforeEach(() => {
  localStorage.clear();
  vi.mocked(runTriageAgent).mockReset();
});
const seed = (title: string, projectPath = "/repo") =>
  createLocalIssue({
    title,
    projectPath,
    status: "backlog",
    description: title,
    priority: 0,
    labels: [],
    agent: "",
  });
const planFor = (issues: LocalIssue[]): TriagePlan => ({
  groups: [
    {
      title: "Streaming",
      reason: "Shared event handling in src/stream.ts",
      files: ["src/stream.ts"],
      issueIds: issues.map((issue) => issue.id),
    },
  ],
  dependencies: [],
});

it("inspects repositories separately and makes no changes until the plan is applied", async () => {
  const a = seed("Stream tokens");
  const b = seed("Stream reconnect", "/other");
  vi.mocked(runTriageAgent).mockImplementation(async ({ issues }) =>
    planFor(issues),
  );
  const preview = await triageBacklog();
  expect(runTriageAgent).toHaveBeenCalledTimes(2);
  expect(runTriageAgent).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: "/repo", issues: [a] }),
  );
  expect(loadLocalIssues().every((issue) => !issue.triageGroup)).toBe(true);
  applyTriagePlan(preview);
  const saved = loadLocalIssues();
  expect(saved[0]!.triageGroup!.id).not.toBe(saved[1]!.triageGroup!.id);
  expect(saved.every((issue) => issue.status === "backlog")).toBe(true);
});

it("rejects omitted, duplicate and cross-project group members without changing storage", () => {
  const a = seed("A");
  const b = seed("B");
  const other = seed("Other", "/other");
  expect(() => validateTriagePlan(planFor([a]), [a, b])).toThrow("omitted");
  const duplicate = planFor([a, b]);
  duplicate.groups[0]!.issueIds.push(a.id);
  expect(() => validateTriagePlan(duplicate, [a, b])).toThrow("exactly one");
  expect(() => validateTriagePlan(planFor([a, other]), [a, other])).toThrow(
    "span projects",
  );
  expect(loadLocalIssues().every((issue) => !issue.triageGroup)).toBe(true);
});

it("rejects invalid plans, missing references and circular dependencies", () => {
  const a = seed("A");
  const b = seed("B");
  expect(() => validateTriagePlan(null, [a, b])).toThrow("invalid plan");
  const plan = planFor([a, b]);
  plan.dependencies = [
    { issueId: a.id, dependsOn: "missing", reason: "Prerequisite" },
  ];
  expect(() => validateTriagePlan(plan, [a, b])).toThrow("same project");
  plan.dependencies = [
    { issueId: a.id, dependsOn: b.id, reason: "First" },
    { issueId: b.id, dependsOn: a.id, reason: "Second" },
  ];
  expect(() => validateTriagePlan(plan, [a, b])).toThrow("cycle");
  expect(loadLocalIssues().every((issue) => !issue.dependsOn)).toBe(true);
});

it("rejects a group deadlock even when individual dependencies have no cycle", () => {
  const [a, b, c, d] = ["A", "B", "C", "D"].map((title) => seed(title));
  const plan = {
    groups: [...planFor([a!, b!]).groups, ...planFor([c!, d!]).groups],
    dependencies: [
      { issueId: a!.id, dependsOn: c!.id, reason: "C first" },
      { issueId: d!.id, dependsOn: b!.id, reason: "B first" },
    ],
  };
  expect(() => validateTriagePlan(plan, [a!, b!, c!, d!])).toThrow(
    "block each other",
  );
});

it("refuses stale triage results and applies dependencies atomically", () => {
  const a = seed("A");
  const b = seed("B");
  const plan = planFor([a, b]);
  plan.dependencies = [
    { issueId: b.id, dependsOn: a.id, reason: "A establishes the protocol" },
  ];
  updateLocalIssue(a.id, { title: "Edited" });
  expect(() => applyTriagePlan({ plan, snapshot: [a, b] })).toThrow(
    "changed during triage",
  );
  expect(loadLocalIssues().every((issue) => !issue.triageGroup)).toBe(true);
  applyTriagePlan({ plan, snapshot: loadLocalIssues() });
  const saved = loadLocalIssues();
  expect(saved[1]!.dependsOn).toEqual([a.id]);
  expect(saved[0]!.triageGroup!.id).toBe(saved[1]!.triageGroup!.id);
});

it("reserves an entire group before launching once and sends prerequisites first", async () => {
  const a = seed("Dependent");
  const b = seed("Prerequisite");
  const plan = planFor([a, b]);
  plan.dependencies = [{ issueId: a.id, dependsOn: b.id, reason: "B first" }];
  applyTriagePlan({ plan, snapshot: [a, b] });
  const groupId = loadLocalIssues()[0]!.triageGroup!.id;
  const launch = vi.fn(async (issue: LocalIssue) => {
    const saved = loadLocalIssues();
    expect(saved.every((entry) => entry.runState === "starting")).toBe(true);
    expect(saved[0]!.runBatchId).toBe(saved[1]!.runBatchId);
    const prompt = localIssueAssignmentPrompt(issue);
    expect(prompt.indexOf(`MC-${b.number}:`)).toBeLessThan(
      prompt.indexOf(`MC-${a.number}:`),
    );
    updateIssueAssignment(issue, {
      sessionId: "shared",
      runState: "running",
      status: "in_progress",
    });
  });
  await startIssueGroup(groupId, launch);
  await expect(startIssueGroup(groupId, launch)).rejects.toThrow(
    "fresh Backlog or To Do",
  );
  expect(launch).toHaveBeenCalledTimes(1);
  expect(loadLocalIssues().every((entry) => entry.sessionId === "shared")).toBe(
    true,
  );
});

it("blocks unfinished external prerequisites but allows a completed prerequisite", async () => {
  const prerequisite = seed("Auth API");
  const a = seed("Auth UI");
  const b = seed("Auth refresh");
  const plan = planFor([a, b]);
  plan.dependencies = [
    { issueId: a.id, dependsOn: prerequisite.id, reason: "Needs the API" },
  ];
  applyTriagePlan({ plan, snapshot: [a, b] });
  const groupId = loadLocalIssues()[1]!.triageGroup!.id;
  const launch = vi.fn(async () => {});
  await expect(startIssueGroup(groupId, launch)).rejects.toThrow(
    `MC-${prerequisite.number}`,
  );
  await expect(startLocalIssue(a.id, launch)).rejects.toThrow("Blocked");
  updateLocalIssue(prerequisite.id, { status: "done" });
  await startIssueGroup(groupId, launch);
  expect(launch).toHaveBeenCalledTimes(1);
});

it("rejects incompatible agent choices and leaves issues unreserved", async () => {
  const a = seed("A");
  const b = seed("B");
  updateLocalIssue(a.id, { agent: "codex" });
  updateLocalIssue(b.id, { agent: "claude" });
  applyTriagePlan({ plan: planFor([a, b]), snapshot: loadLocalIssues() });
  await expect(
    startIssueGroup(loadLocalIssues()[0]!.triageGroup!.id, vi.fn()),
  ).rejects.toThrow("same agent");
  expect(
    loadLocalIssues().every((issue) => !issue.runBatchId && !issue.runState),
  ).toBe(true);
});

it("releases every group reservation on a refused launch and retries in one assignment", async () => {
  const a = seed("A");
  const b = seed("B");
  applyTriagePlan({ plan: planFor([a, b]), snapshot: [a, b] });
  await expect(
    startIssueGroup(loadLocalIssues()[0]!.triageGroup!.id, async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(
    loadLocalIssues().every(
      (issue) =>
        issue.runState === "failed" &&
        issue.status === "todo" &&
        !issue.runOwner,
    ),
  ).toBe(true);
  const launch = vi.fn(async () => {});
  await startLocalIssue(b.id, launch);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(
    loadLocalIssues().every((issue) => issue.runState === "starting"),
  ).toBe(true);
});

it("preserves per-ticket review history and requires the entire group to be reviewed for a commit", async () => {
  const a = seed("A");
  const b = seed("B");
  applyTriagePlan({ plan: planFor([a, b]), snapshot: [a, b] });
  await startIssueGroup(
    loadLocalIssues()[0]!.triageGroup!.id,
    async (issue) => {
      updateIssueAssignment(issue, { sessionId: "shared" });
    },
  );
  const ownReview = {
    id: "peer",
    at: new Date().toISOString(),
    text: "B's peer review",
    kind: "peer" as const,
  };
  updateLocalIssue(b.id, { reviews: [ownReview] });
  const result = {
    id: "work",
    at: new Date().toISOString(),
    text: "Both done",
    kind: "work" as const,
  };
  updateIssueAssignment(loadLocalIssues()[0]!, {
    runState: "completed",
    status: "in_review",
    reviews: [result],
    runOwner: undefined,
  });
  expect(loadLocalIssues()[1]!.reviews).toEqual([ownReview, result]);
  updateLocalIssue(b.id, { status: "todo" });
  await expect(
    startLocalIssue(a.id, vi.fn(), { kind: "commit" }),
  ).rejects.toThrow("Every issue");
  updateLocalIssue(b.id, { status: "in_review" });
  await startLocalIssue(
    a.id,
    async (issue) => {
      expect(
        loadLocalIssues().every((entry) => entry.status === "in_review"),
      ).toBe(true);
      updateIssueAssignment(issue, { commitSha: "abc", runState: "completed" });
    },
    { kind: "commit" },
  );
  expect(loadLocalIssues().every((entry) => entry.commitSha === "abc")).toBe(
    true,
  );
});

it("prevents partial writes when any dependency edit is invalid", () => {
  const a = seed("A");
  const b = seed("B");
  expect(() =>
    updateLocalIssues([
      { id: a.id, patch: { title: "Changed" } },
      { id: b.id, patch: { dependsOn: ["unknown"] } },
    ]),
  ).toThrow("same project");
  expect(loadLocalIssues()[0]!.title).toBe("A");
});

it("keeps dependents blocked during a commit and after it fails", async () => {
  const a = seed("Prerequisite");
  const b = seed("Dependent");
  updateLocalIssue(a.id, {
    status: "in_review",
    sessionId: "thread",
    runState: "completed",
  });
  updateLocalIssue(b.id, { dependsOn: [a.id] });
  let reject!: (error: Error) => void;
  const pending = startLocalIssue(
    a.id,
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    { kind: "commit" },
  );
  expect(loadLocalIssues()[0].status).toBe("in_review");
  expect(issueBlockers(loadLocalIssues()[1])).toHaveLength(1);
  await expect(startLocalIssue(b.id, vi.fn())).rejects.toThrow();
  reject(new Error("commit failed"));
  await expect(pending).rejects.toThrow("commit failed");
  expect(issueBlockers(loadLocalIssues()[1])).toHaveLength(1);
  updateLocalIssue(a.id, {
    status: "done",
    runState: "completed",
    commitSha: "committed",
  });
  const launch = vi.fn(async () => {});
  await startLocalIssue(b.id, launch);
  expect(launch).toHaveBeenCalledOnce();
});

it("detaches project moves before dispatch and rejects legacy mixed-project groups", async () => {
  const a = seed("A");
  const b = seed("B");
  applyTriagePlan({ plan: planFor([a, b]), snapshot: [a, b] });
  const group = loadLocalIssues()[0].triageGroup!;
  updateLocalIssue(b.id, { projectPath: "/other" });
  expect(loadLocalIssues()[1].triageGroup).toBeUndefined();
  updateLocalIssues([{ id: b.id, patch: { triageGroup: group } }]);
  await expect(startIssueGroup(group.id, vi.fn())).rejects.toThrow(
    "span projects",
  );
  updateLocalIssue(b.id, { projectPath: "/repo" });
  await startIssueGroup(group.id, async (issue) => {
    updateIssueAssignment(issue, {
      sessionId: "thread",
      runState: "completed",
    });
  });
  expect(() => updateLocalIssue(a.id, { projectPath: "/other" })).toThrow(
    "cannot change projects",
  );
});

it("serializes working-copy assignments through review, including archived unfinished work", async () => {
  const a = seed("A");
  const b = seed("B");
  await startLocalIssue(a.id, async (issue) => {
    updateLocalIssue(issue.id, {
      sessionId: "a",
      runState: "completed",
      status: "in_review",
    });
  });
  await expect(startLocalIssue(b.id, vi.fn())).rejects.toThrow(
    "Waiting for MC",
  );
  updateLocalIssue(a.id, { archived: true });
  await expect(startLocalIssue(b.id, vi.fn())).rejects.toThrow(
    "Waiting for MC",
  );
  updateLocalIssue(a.id, {
    archived: false,
    status: "done",
    commitSha: "a",
    runKind: "commit",
    runState: "completed",
  });
  await expect(startLocalIssue(b.id, async () => {})).resolves.toBeUndefined();
});

it("preserves triage on a move to To Do, starts the group, and never resumes archived members", async () => {
  const a = seed("A");
  const b = seed("B");
  const plan = planFor([a, b]);
  plan.dependencies = [{ issueId: b.id, dependsOn: a.id, reason: "A first" }];
  applyTriagePlan({ plan, snapshot: [a, b] });
  const triaged = loadLocalIssues()[1];
  const launch = vi.fn();
  await expect(moveLocalIssue(b.id, "todo", launch)).resolves.toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
  expect(loadLocalIssues()[1]).toMatchObject({
    status: "todo",
    triageGroup: triaged.triageGroup,
    triageDependencies: [a.id],
    dependsOn: [a.id],
  });
  expect(loadLocalIssues()[0].status).toBe("backlog");
  await startIssueGroup(loadLocalIssues()[0].triageGroup!.id, async (issue) => {
    expect(issueAssignment(issue).map((entry) => entry.id)).toEqual([
      a.id,
      b.id,
    ]);
    updateIssueAssignment(issue, {
      sessionId: "shared",
      runState: "completed",
      status: "in_review",
    });
  });
  updateLocalIssue(b.id, { archived: true });
  await startLocalIssue(
    a.id,
    async (issue) => {
      expect(issueAssignment(issue).map((entry) => entry.id)).toEqual([a.id]);
    },
    { feedback: "Revise A" },
  );
  expect(loadLocalIssues()[1]).toMatchObject({
    archived: true,
    status: "in_review",
    runState: "completed",
  });
  await expect(startLocalIssue(b.id, vi.fn())).rejects.toThrow("Restore");
});

it("records partial outcomes and does not assume omitted tickets are complete", () => {
  const a = seed("A");
  const b = seed("B");
  const c = seed("C");
  updateLocalIssues(
    [a, b, c].map((issue) => ({
      id: issue.id,
      patch: { runBatchId: "batch" },
    })),
  );
  const output =
    "```issue-results\n" +
    JSON.stringify({
      [`MC-${a.number}`]: { status: "ready", summary: "Tested" },
      [`MC-${b.number}`]: { status: "blocked", summary: "Needs credentials" },
    }) +
    "\n```";
  updateIssueAssignment(
    loadLocalIssues()[0],
    { runState: "completed" },
    "Results",
    parseIssueOutcomes(output, loadLocalIssues()),
  );
  expect(
    loadLocalIssues().map((issue) => [issue.status, issue.workOutcome?.status]),
  ).toEqual([
    ["in_review", "ready"],
    ["todo", "blocked"],
    ["todo", "needs_work"],
  ]);
});

it("retriages selected tickets without retaining obsolete model dependencies or changing manual ones", () => {
  const a = seed("A");
  const b = seed("B");
  const manual = seed("Manual prerequisite");
  updateLocalIssue(a.id, { dependsOn: [manual.id] });
  const first = planFor([loadLocalIssues()[0], b]);
  first.dependencies.push({
    issueId: a.id,
    dependsOn: b.id,
    reason: "Initial ordering",
  });
  applyTriagePlan({ plan: first, snapshot: loadLocalIssues().slice(0, 2) });
  expect(loadLocalIssues()[0].triageDependencies).toEqual([b.id]);
  applyTriagePlan({
    plan: planFor([a, b]),
    snapshot: loadLocalIssues().slice(0, 2),
  });
  expect(loadLocalIssues()[0].dependsOn).toEqual([manual.id]);
  detachUnstartedIssue(a.id);
  expect(loadLocalIssues()[0].triageGroup).toBeUndefined();
});

it("batches more than 100 tickets, saves drafts and preserves successful projects when another fails", async () => {
  Array.from({ length: 101 }, (_, index) => seed(`Ticket ${index}`));
  seed("Failing project", "/other");
  vi.mocked(runTriageAgent).mockImplementation(async (input) => {
    if (input.cwd === "/other") throw new Error("offline");
    return planFor(input.issues);
  });
  const result = await triageBacklog(undefined, {
    onProgress: (partial) => {
      if (partial.snapshot.length) saveTriageDraft(partial);
    },
  });
  expect(runTriageAgent).toHaveBeenCalledTimes(3);
  expect(result.snapshot).toHaveLength(101);
  expect(result.warnings?.join(" ")).toContain("offline");
  expect(loadTriageDraft()?.snapshot).toHaveLength(101);
  applyTriagePlan(result);
  expect(loadLocalIssues().at(-1)?.triageGroup).toBeUndefined();
});

it("honors ticket selection and cancellation without applying a late model response", async () => {
  const a = seed("A");
  seed("Unselected");
  const controller = new AbortController();
  let finish!: (value: TriagePlan) => void;
  vi.mocked(runTriageAgent).mockImplementation(async () => {
    return new Promise<TriagePlan>((resolve) => {
      finish = resolve;
    });
  });
  const pending = triageBacklog("/repo", {
    issueIds: [a.id],
    signal: controller.signal,
  });
  expect(runTriageAgent).toHaveBeenCalledWith(
    expect.objectContaining({ issues: [a], signal: controller.signal }),
  );
  controller.abort();
  finish(planFor([a]));
  await expect(pending).rejects.toThrow("cancelled");
  expect(loadLocalIssues().every((issue) => !issue.triageGroup)).toBe(true);
});
