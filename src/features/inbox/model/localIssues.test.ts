// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalIssue,
  loadLocalIssues,
  LOCAL_ISSUES_KEY,
  localIssuePrompt,
  moveLocalIssue,
  recoverLocalIssueRuns,
  startLocalIssue,
  updateLocalIssue,
  verifiedIssueCommit,
  type IssueDraft,
  type LocalIssue,
} from "./localIssues";
import { issueProofPaths } from "./localIssueImages";

const draft: IssueDraft = {
  title: "Fix the sidebar",
  description: "Acceptance criteria: no clipping.",
  status: "backlog",
  priority: 2,
  projectPath: "/tmp/web",
  labels: [" ui ", "ui", "accessibility"],
  agent: "codex",
};

describe("local issue workflow", () => {
  beforeEach(() => localStorage.clear());
  it("requires a new actual HEAD reported by the agent before marking a commit complete", () => {
    expect(
      verifiedIssueCommit("aaa1111", "bbb2222ccc", "Committed bbb2222"),
    ).toBe(true);
    expect(verifiedIssueCommit("aaa1111", "aaa1111", "Committed aaa1111")).toBe(
      false,
    );
    expect(
      verifiedIssueCommit("aaa1111", "bbb2222ccc", "Unable to commit"),
    ).toBe(false);
    expect(verifiedIssueCommit("aaa1111", null, "Committed bbb2222")).toBe(
      false,
    );
  });
  it("extracts distinct absolute evidence image paths, ignoring external URLs", () => {
    expect(
      issueProofPaths(
        "![Proof](</tmp/my proof.png>) ![Again](</tmp/my proof.png>) ![Remote](https://example.com/image.png)",
      ),
    ).toEqual(["/tmp/my proof.png"]);
  });

  it("builds the prompt from the title, description, images, and selected model options", () => {
    const legacyDraft = {
      ...draft,
      title: "Inspect this screenshot",
      description: "Explain the clipping shown in the screenshot.",
      prompt: "Obsolete separate instructions",
      model: "codex:gpt-6.1-sol",
      modelSettings: { reasoningEffort: "low", serviceTier: "priority" },
      images: [
        {
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          size: 123,
        },
      ],
    };
    const issue = createLocalIssue(legacyDraft);
    const prompt = localIssuePrompt(issue);
    for (const text of [
      legacyDraft.title,
      legacyDraft.description,
      "screenshot.png",
      legacyDraft.model,
      '"reasoningEffort":"low"',
      '"serviceTier":"priority"',
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toContain(legacyDraft.prompt);
    expect(loadLocalIssues()[0]).toMatchObject({
      model: legacyDraft.model,
      modelSettings: legacyDraft.modelSettings,
      images: legacyDraft.images,
    });
  });

  it("makes interrupted runs retryable after restart while preserving active runs and thread links", () => {
    const stopped = createLocalIssue(draft);
    const live = createLocalIssue(draft);
    updateLocalIssue(stopped.id, {
      runState: "running",
      sessionId: "stopped-thread",
      status: "in_progress",
    });
    updateLocalIssue(live.id, {
      runState: "running",
      sessionId: "live-thread",
      status: "in_progress",
    });
    recoverLocalIssueRuns((id) => id === "live-thread");
    expect(loadLocalIssues()[0]).toMatchObject({
      runState: "failed",
      sessionId: "stopped-thread",
      status: "in_progress",
    });
    expect(loadLocalIssues()[1]).toMatchObject({
      runState: "running",
      sessionId: "live-thread",
    });
  });

  it("persists issue details, normalizes labels, and keeps identifiers stable through archive/restore", () => {
    const first = createLocalIssue(draft);
    updateLocalIssue(first.id, { archived: true });
    const second = createLocalIssue({ ...draft, title: "Second issue" });
    updateLocalIssue(first.id, { archived: false });
    expect(second.number).toBe(first.number + 1);
    expect(loadLocalIssues()[0]).toMatchObject({
      id: first.id,
      labels: ["ui", "accessibility"],
      archived: false,
      description: draft.description,
    });
  });

  it("dispatches Backlog to To Do exactly once even when two transitions arrive together", async () => {
    const issue = createLocalIssue(draft);
    let finish!: () => void;
    const launch = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const first = moveLocalIssue(issue.id, "todo", launch);
    await moveLocalIssue(issue.id, "todo", launch);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(loadLocalIssues()[0]).toMatchObject({
      status: "todo",
      runState: "starting",
    });
    finish();
    await first;
  });

  it("includes the full title, supporting details, properties, and comments in agent context", () => {
    const issue = createLocalIssue(draft);
    const withComment = updateLocalIssue(
      issue.id,
      {},
      "Also validate reduced motion.",
    );
    const prompt = localIssuePrompt(withComment);
    for (const text of [
      draft.description,
      "Priority: High",
      "Project: /tmp/web",
      "Labels: ui, accessibility",
      "Agent: codex",
      "Also validate reduced motion.",
      `MC-${issue.number}`,
    ])
      expect(prompt).toContain(text);
  });

  it("keeps a failed dispatch retryable and retains the dedicated thread identity", async () => {
    const issue = createLocalIssue(draft);
    await expect(
      startLocalIssue(issue.id, async () => {
        updateLocalIssue(issue.id, { sessionId: "saved-thread" });
        throw new Error("Provider offline");
      }),
    ).rejects.toThrow("Provider offline");
    expect(loadLocalIssues()[0]).toMatchObject({
      sessionId: "saved-thread",
      runState: "failed",
      runError: "Provider offline",
    });
    const retry = vi.fn(async (_issue: LocalIssue) => {});
    await startLocalIssue(issue.id, retry);
    expect(retry.mock.calls[0][0]).toMatchObject({ sessionId: "saved-thread" });
  });

  it("leaves Backlog intact when a project or dispatch integration is unavailable", async () => {
    const noProject = createLocalIssue({ ...draft, projectPath: "" });
    await expect(
      moveLocalIssue(noProject.id, "todo", async () => {}),
    ).rejects.toThrow("Choose a project");
    const issue = createLocalIssue(draft);
    await expect(moveLocalIssue(issue.id, "todo")).rejects.toThrow(
      "dispatch is unavailable",
    );
    expect(loadLocalIssues().every((issue) => issue.status === "backlog")).toBe(
      true,
    );
  });

  it("does not start agents for other transitions and protects running issues", async () => {
    const issue = createLocalIssue(draft);
    const launch = vi.fn(async () => {});
    await moveLocalIssue(issue.id, "done", launch);
    expect(launch).not.toHaveBeenCalled();
    updateLocalIssue(issue.id, { status: "in_progress", runState: "running" });
    await expect(moveLocalIssue(issue.id, "backlog", launch)).rejects.toThrow(
      "agent is working",
    );
    expect(loadLocalIssues()[0].status).toBe("in_progress");
  });

  it("preserves corrupted data and reports failed saves without dispatching", async () => {
    localStorage.setItem(LOCAL_ISSUES_KEY, '{"unexpected":"data"}');
    expect(() => createLocalIssue(draft)).toThrow(
      "saved data has been preserved",
    );
    expect(localStorage.getItem(LOCAL_ISSUES_KEY)).toBe(
      '{"unexpected":"data"}',
    );
    localStorage.clear();
    const issue = createLocalIssue(draft);
    const launch = vi.fn(async () => {});
    const storage = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Disk quota");
    });
    await expect(startLocalIssue(issue.id, launch)).rejects.toThrow(
      "Disk quota",
    );
    expect(launch).not.toHaveBeenCalled();
    storage.mockRestore();
    expect(loadLocalIssues()[0].status).toBe("backlog");
  });

  it("archives retired column records without losing their details", () => {
    const issue = createLocalIssue(draft);
    localStorage.setItem(
      LOCAL_ISSUES_KEY,
      JSON.stringify([{ ...issue, status: "duplicate" }]),
    );
    expect(loadLocalIssues()[0]).toMatchObject({
      id: issue.id,
      status: "backlog",
      archived: true,
      description: issue.description,
    });
  });

  it("reserves feedback once and preserves the review history", async () => {
    const issue = createLocalIssue(draft);
    updateLocalIssue(issue.id, {
      status: "in_review",
      sessionId: "thread",
      reviews: [{ id: "r", text: "Proof", at: "today", kind: "work" }],
    });
    const launch = vi.fn(async () => {});
    await startLocalIssue(issue.id, launch, {
      feedback: "Needs more evidence",
    });
    await startLocalIssue(issue.id, launch, {
      feedback: "Needs more evidence",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(loadLocalIssues()[0]).toMatchObject({
      status: "in_progress",
      runState: "starting",
      sessionId: "thread",
      feedback: "Needs more evidence",
      reviews: [{ text: "Proof" }],
    });
  });
});
