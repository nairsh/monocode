// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  createLocalIssue,
  loadLocalIssues,
  updateLocalIssue,
} from "./localIssues";
import {
  canCommitWithTaskModel,
  commitIssueWithTaskModel,
} from "./taskModelCommit";
import * as fs from "../../../platform/tauri/fs";
import { taskModelCommitMessage } from "../../settings/model/taskModel";

vi.mock("../../../platform/tauri/fs", () => ({
  gitCommit: vi.fn(),
  gitHistory: vi.fn(),
  gitStageFile: vi.fn(),
  gitStagedContext: vi.fn(),
  gitUnstageFile: vi.fn(),
}));
vi.mock("../../settings/model/taskModel", () => ({
  taskModelCommitMessage: vi.fn(),
}));

function approved() {
  const issue = createLocalIssue({
    title: "Fix clipping",
    description: "",
    status: "backlog",
    priority: 0,
    projectPath: "/tmp/web",
    agent: "",
    labels: [],
  });
  return updateLocalIssue(issue.id, {
    status: "done",
    runState: "starting",
    runKind: "commit",
    commitFiles: ["src/a.ts", "src/b.ts"],
    reviews: [
      { id: "w", text: "Work summary", at: "2026-01-01", kind: "work" },
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(fs.gitStagedContext).mockResolvedValue({
    branch: "main",
    summary: "2 files",
    patch: "diff",
  });
  vi.mocked(fs.gitUnstageFile).mockResolvedValue(undefined);
  vi.mocked(taskModelCommitMessage).mockResolvedValue("fix(ui): stop clipping");
});

it("decides the task-model path from config and recorded files", () => {
  const issue = approved();
  expect(canCommitWithTaskModel(issue, true)).toBe(true);
  expect(canCommitWithTaskModel(issue, false)).toBe(false);
  expect(canCommitWithTaskModel({ ...issue, commitFiles: [] }, true)).toBe(
    false,
  );
});

it("stages only recorded files, commits, and records the verified sha", async () => {
  const issue = approved();
  vi.mocked(fs.gitHistory)
    .mockResolvedValueOnce({ head: "aaa1111", commits: [] })
    .mockResolvedValueOnce({
      head: "bbb2222ccc",
      commits: [
        {
          sha: "bbb2222ccc",
          shortSha: "bbb2222",
          parents: [],
          author: "Ada",
          timestamp: 1_800_000_000,
          subject: "fix(ui): stop clipping",
          refs: [],
          head: true,
        },
      ],
    });
  await commitIssueWithTaskModel(issue, "/tmp/web");
  expect(fs.gitStageFile).toHaveBeenCalledTimes(2);
  expect(fs.gitStageFile).toHaveBeenCalledWith("/tmp/web", "src/b.ts");
  expect(taskModelCommitMessage).toHaveBeenCalledWith(
    expect.objectContaining({ workSummary: "Work summary", diff: "diff" }),
  );
  expect(fs.gitCommit).toHaveBeenCalledWith(
    "/tmp/web",
    "fix(ui): stop clipping",
    false,
    ["src/a.ts", "src/b.ts"],
  );
  const saved = loadLocalIssues()[0]!;
  expect(saved).toMatchObject({
    status: "done",
    runState: "completed",
    commitSha: "bbb2222ccc",
    commitMeta: { subject: "fix(ui): stop clipping", author: "Ada" },
  });
  expect(saved.reviews!.at(-1)!.kind).toBe("commit");
  expect(saved.activity.at(-1)!.text).toBe(
    "Committed approved changes; issue done",
  );
});

it("returns to review and unstages when the message cannot be generated", async () => {
  const issue = approved();
  vi.mocked(fs.gitHistory).mockResolvedValue({ head: "aaa1111", commits: [] });
  vi.mocked(taskModelCommitMessage).mockRejectedValue(new Error("offline"));
  await commitIssueWithTaskModel(issue, "/tmp/web");
  expect(fs.gitCommit).not.toHaveBeenCalled();
  expect(fs.gitUnstageFile).toHaveBeenCalledTimes(2);
  expect(loadLocalIssues()[0]).toMatchObject({
    status: "in_review",
    runState: "failed",
    runError: expect.stringContaining("offline"),
  });
});

it("rejects a commit that did not move HEAD", async () => {
  const issue = approved();
  vi.mocked(fs.gitHistory).mockResolvedValue({ head: "aaa1111", commits: [] });
  await commitIssueWithTaskModel(issue, "/tmp/web");
  expect(loadLocalIssues()[0]).toMatchObject({
    status: "in_review",
    runState: "failed",
  });
  expect(loadLocalIssues()[0]!.commitSha).toBeUndefined();
});
