// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canPeerReview,
  capReviewText,
  createLocalIssue,
  hasWorkReview,
  ISSUE_WINDOW_ID,
  issueRunFailurePatch,
  loadLocalIssues,
  LOCAL_ISSUES_KEY,
  localIssueFeedbackPrompt,
  localIssuePrompt,
  moveLocalIssue,
  parseCommitPlan,
  peerReviewOf,
  peerReviewPrompt,
  recoverLocalIssueRuns,
  staleIssueRuns,
  startLocalIssue,
  startPeerReview,
  touchIssueRunLeases,
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
  it("treats a commit as real only when git HEAD moved, whatever the agent says", () => {
    expect(verifiedIssueCommit("aaa1111", "bbb2222ccc")).toBe(true);
    expect(verifiedIssueCommit(null, "bbb2222ccc")).toBe(true);
    expect(verifiedIssueCommit("aaa1111", "aaa1111")).toBe(false);
    expect(verifiedIssueCommit("aaa1111", null)).toBe(false);
    expect(verifiedIssueCommit(undefined, undefined)).toBe(false);
  });
  it("reads the agent's commit plan and ignores unsafe paths", () => {
    const reply = [
      "Done.",
      "```commit-files",
      "- src/a.ts",
      "`src/b.ts`",
      "/etc/passwd",
      "../escape.ts",
      "src/a.ts",
      "```",
      "Commit subject: fix(ui): stop clipping",
    ].join("\n");
    expect(parseCommitPlan(reply)).toEqual({
      files: ["src/a.ts", "src/b.ts"],
      subject: "fix(ui): stop clipping",
    });
    expect(parseCommitPlan("No plan here")).toEqual({
      files: [],
      subject: undefined,
    });
    const issue = createLocalIssue(draft);
    expect(localIssuePrompt(issue)).toContain("```commit-files");
    expect(localIssueFeedbackPrompt(issue, "x")).toContain("```commit-files");
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
      status: "todo",
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
    expect(loadLocalIssues()[0].activity.at(-1)?.text).toBe(
      "Marked done without a commit",
    );
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
    // Replace the whole store: spying on setItem differs between Node's and happy-dom's Storage.
    const real = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => real.getItem(key),
      setItem: () => {
        throw new Error("Disk quota");
      },
    });
    await expect(startLocalIssue(issue.id, launch)).rejects.toThrow(
      "Disk quota",
    );
    expect(launch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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

  describe("run leases", () => {
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    const ago = (seconds: number) =>
      new Date(now - seconds * 1000).toISOString();
    const running = (patch: Partial<LocalIssue>): LocalIssue => ({
      ...createLocalIssue(draft),
      status: "in_progress",
      runState: "running",
      sessionId: "thread",
      ...patch,
    });
    const stale = (issues: LocalIssue[], busy: string[] = []) =>
      staleIssueRuns(issues, now, "me", (id) => !!id && busy.includes(id)).map(
        (entry) => entry.issue.id,
      );

    it("leaves another window's run alone while its heartbeat is fresh", () => {
      const fresh = running({ runOwner: "other", runHeartbeatAt: ago(30) });
      const old = running({ runOwner: "other", runHeartbeatAt: ago(46) });
      const legacy = running({});
      const garbled = running({
        runOwner: "other",
        runHeartbeatAt: "yesterday",
      });
      expect(stale([fresh, old, legacy, garbled])).toEqual([
        old.id,
        legacy.id,
        garbled.id,
      ]);
    });

    it("never fails a run whose session is busy in this window", () => {
      const legacy = running({});
      const own = running({ runOwner: "me", runHeartbeatAt: ago(1) });
      expect(stale([legacy, own], ["thread"])).toEqual([]);
    });

    it("fails this window's run when its session stopped without settling", () => {
      const own = running({ runOwner: "me", runHeartbeatAt: ago(1) });
      expect(stale([own])).toEqual([own.id]);
    });

    it("gives this window's launch two minutes before calling it never started", () => {
      const launching = running({
        runState: "starting",
        sessionId: undefined,
        runOwner: "me",
        updatedAt: ago(60),
      });
      const stuck = running({
        runState: "starting",
        sessionId: undefined,
        runOwner: "me",
        updatedAt: ago(121),
      });
      const result = staleIssueRuns([launching, stuck], now, "me", () => false);
      expect(result.map((entry) => entry.issue.id)).toEqual([stuck.id]);
      expect(result[0].error).toBe("The agent never started.");
    });

    it("refreshes only this window's heartbeat, without activity or edits", () => {
      const own = createLocalIssue(draft);
      const other = createLocalIssue(draft);
      for (const [issue, owner] of [
        [own, ISSUE_WINDOW_ID],
        [other, "another-window"],
      ] as const)
        updateLocalIssue(issue.id, {
          runState: "running",
          runOwner: owner,
          runHeartbeatAt: ago(30),
        });
      const before = loadLocalIssues();
      expect(touchIssueRunLeases(ISSUE_WINDOW_ID, now)).toBe(true);
      const [mine, theirs] = loadLocalIssues();
      expect(mine.runHeartbeatAt).toBe(new Date(now).toISOString());
      expect(mine.activity).toEqual(before[0].activity);
      expect(mine.updatedAt).toBe(before[0].updatedAt);
      expect(theirs).toEqual(before[1]);
      expect(touchIssueRunLeases("nobody", now)).toBe(false);
    });

    it("reserves a run for this window and recovery returns reviewed work to review", async () => {
      const issue = createLocalIssue(draft);
      updateLocalIssue(issue.id, {
        status: "in_review",
        sessionId: "thread",
        reviews: [{ id: "r", text: "Proof", at: "today", kind: "work" }],
      });
      await startLocalIssue(issue.id, async () => {}, { feedback: "More" });
      expect(loadLocalIssues()[0]).toMatchObject({
        runOwner: ISSUE_WINDOW_ID,
        status: "in_progress",
      });
      expect(
        Date.now() - Date.parse(loadLocalIssues()[0].runHeartbeatAt!),
      ).toBeLessThan(5000);
      recoverLocalIssueRuns(
        () => false,
        Date.now() + 3 * 60_000,
        "a-later-window",
      );
      expect(loadLocalIssues()[0]).toMatchObject({
        runState: "failed",
        status: "in_review",
      });
      expect(loadLocalIssues()[0].runOwner).toBeUndefined();
      expect(loadLocalIssues()[0].runHeartbeatAt).toBeUndefined();
    });

    it("rejects malformed lease fields instead of overwriting the store", () => {
      const issue = createLocalIssue(draft);
      localStorage.setItem(
        LOCAL_ISSUES_KEY,
        JSON.stringify([{ ...issue, runOwner: 5 }]),
      );
      expect(() => loadLocalIssues()).toThrow("saved data has been preserved");
    });
  });

  describe("approval and commit", () => {
    const reviewed = () => {
      const issue = createLocalIssue(draft);
      updateLocalIssue(issue.id, {
        status: "in_review",
        sessionId: "thread",
        runState: "completed",
        reviews: [{ id: "r", text: "Proof", at: "today", kind: "work" }],
      });
      return issue;
    };

    it("moves to Done immediately, once, while the commit run starts", async () => {
      const issue = reviewed();
      let finish!: () => void;
      const launch = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const first = startLocalIssue(issue.id, launch, { kind: "commit" });
      await startLocalIssue(issue.id, launch, { kind: "commit" });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(loadLocalIssues()[0]).toMatchObject({
        status: "done",
        runKind: "commit",
        runState: "starting",
        sessionId: "thread",
      });
      finish();
      await first;
    });

    it("returns the issue to In Review when the commit cannot start", async () => {
      const issue = reviewed();
      await expect(
        startLocalIssue(
          issue.id,
          async () => {
            throw new Error("Git is locked");
          },
          { kind: "commit" },
        ),
      ).rejects.toThrow("Git is locked");
      expect(loadLocalIssues()[0]).toMatchObject({
        status: "in_review",
        runState: "failed",
        runError: "Git is locked",
      });
      expect(loadLocalIssues()[0].runOwner).toBeUndefined();
    });

    it("returns failed or cancelled commit and feedback runs to In Review", () => {
      const issue = reviewed();
      const started = (patch: Partial<LocalIssue>) =>
        updateLocalIssue(issue.id, { runState: "running", ...patch });
      for (const patch of [
        { runKind: "commit" as const, status: "done" as const },
        { runKind: "work" as const, status: "in_progress" as const },
      ])
        for (const state of ["failed", "cancelled"] as const) {
          const current = started(patch);
          updateLocalIssue(
            issue.id,
            issueRunFailurePatch(current, state, "Stopped"),
          );
          expect(loadLocalIssues()[0]).toMatchObject({
            status: "in_review",
            runState: state,
            runError: "Stopped",
          });
        }
    });

    it("keeps a failed first run in To Do and retryable", async () => {
      const issue = createLocalIssue(draft);
      await expect(
        startLocalIssue(issue.id, async () => {
          throw new Error("Offline");
        }),
      ).rejects.toThrow("Offline");
      expect(loadLocalIssues()[0]).toMatchObject({
        status: "todo",
        runState: "failed",
      });
    });
  });

  describe("manual status moves", () => {
    it("blocks moving into In Progress, which only an agent run sets", async () => {
      const issue = createLocalIssue(draft);
      await expect(
        moveLocalIssue(
          issue.id,
          "in_progress",
          vi.fn(async () => {}),
        ),
      ).rejects.toThrow("In Progress is set when an agent starts");
      expect(loadLocalIssues()[0].status).toBe("backlog");
    });

    it("dispatches the agent from any idle status and reuses the thread", async () => {
      for (const from of ["in_review", "done"] as const) {
        localStorage.clear();
        const issue = createLocalIssue(draft);
        updateLocalIssue(issue.id, { status: from, sessionId: "thread" });
        const launch = vi.fn(async (_issue: LocalIssue) => {});
        await moveLocalIssue(issue.id, "todo", launch);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(launch.mock.calls[0][0]).toMatchObject({
          status: "todo",
          sessionId: "thread",
          runKind: "work",
        });
      }
    });

    it("does not dispatch for a no-op move or a move out to Backlog or In Review", async () => {
      const issue = createLocalIssue(draft);
      const launch = vi.fn(async () => {});
      await moveLocalIssue(issue.id, "backlog", launch);
      await moveLocalIssue(issue.id, "in_review", launch);
      await moveLocalIssue(issue.id, "backlog", launch);
      expect(launch).not.toHaveBeenCalled();
      expect(loadLocalIssues()[0].status).toBe("backlog");
    });

    it("explains when dispatch is unavailable from a later status", async () => {
      const issue = createLocalIssue(draft);
      updateLocalIssue(issue.id, { status: "done" });
      await expect(moveLocalIssue(issue.id, "todo")).rejects.toThrow(
        "dispatch is unavailable. The issue is still in Done",
      );
    });
  });

  describe("stored data limits and prompts", () => {
    it("keeps the feedback prompt to the feedback, not the whole issue", () => {
      const issue = createLocalIssue(draft);
      const prompt = localIssueFeedbackPrompt(issue, "Tighten the spacing");
      expect(prompt).toContain(`Continue local issue MC-${issue.number}`);
      expect(prompt).toContain("in this same thread");
      expect(prompt).toContain("Review feedback:\nTighten the spacing");
      expect(prompt).toContain("Do not commit yet");
      expect(prompt).toContain("Markdown image links to absolute");
      expect(prompt).not.toContain(draft.description);
      expect(prompt).not.toContain("Priority:");
    });

    it("caps stored activity at 200 entries and the prompt at the latest 20", () => {
      const issue = createLocalIssue(draft);
      for (let index = 0; index < 250; index++)
        updateLocalIssue(issue.id, {}, `Event ${index}`);
      const stored = loadLocalIssues()[0];
      expect(stored.activity).toHaveLength(200);
      expect(stored.activity.at(-1)?.text).toBe("Event 249");
      expect(stored.activity[0].text).toBe("Event 50");
      const prompt = localIssuePrompt(stored);
      expect(prompt).toContain("Event 249");
      expect(prompt).toContain("Event 230");
      expect(prompt).not.toContain("Event 229");
    });

    it("truncates oversized review text with a pointer to the thread", () => {
      const issue = createLocalIssue(draft);
      updateLocalIssue(issue.id, {
        reviews: [
          { id: "r", text: "x".repeat(50_000), at: "today", kind: "work" },
        ],
      });
      const text = loadLocalIssues()[0].reviews![0].text;
      expect(text.length).toBeLessThan(20_100);
      expect(text).toContain("truncated; open the thread for the full reply");
      expect(capReviewText("short")).toBe("short");
    });
  });

  describe("review with another model", () => {
    const reviewedIssue = () => {
      const issue = createLocalIssue(draft);
      return updateLocalIssue(issue.id, {
        status: "in_review",
        sessionId: "work-thread",
        runState: "completed",
        reviews: [
          { id: "w1", text: "Old summary", at: "a", kind: "work" },
          { id: "w2", text: "Latest summary", at: "b", kind: "work" },
        ],
      });
    };

    it("is offered only for an idle issue with a work thread and a work review", () => {
      const issue = reviewedIssue();
      expect(canPeerReview(issue)).toBe(true);
      expect(canPeerReview({ ...issue, runState: "running" })).toBe(false);
      expect(canPeerReview({ ...issue, sessionId: undefined })).toBe(false);
      expect(canPeerReview({ ...issue, reviews: undefined })).toBe(false);
      expect(
        canPeerReview({
          ...issue,
          reviews: [{ id: "p", text: "x", at: "a", kind: "peer" }],
        }),
      ).toBe(false);
    });

    it("sends a compact prompt: issue, latest work summary, capped diff, no transcript", () => {
      const prompt = peerReviewPrompt(reviewedIssue(), {
        summary: " a.ts | 2 +-",
        patch: `+${"x".repeat(30_000)}`,
      });
      expect(prompt).toContain("Fix the sidebar");
      expect(prompt).toContain("Latest summary");
      expect(prompt).not.toContain("Old summary");
      expect(prompt).toContain("a.ts | 2 +-");
      expect(prompt).toContain("do not modify");
      expect(prompt).toContain("at most 10 bullets");
      expect(prompt).toContain("[truncated]");
      expect(prompt.length).toBeLessThan(19_000);
    });

    it("keeps peer reviews out of the work and failure logic", () => {
      const issue = reviewedIssue();
      const peerOnly = {
        ...issue,
        reviews: [{ id: "p", text: "x", at: "a", kind: "peer" as const }],
      };
      expect(hasWorkReview(peerOnly)).toBe(false);
      expect(issueRunFailurePatch(peerOnly, "failed").status).toBe("todo");
      expect(issueRunFailurePatch(issue, "failed").status).toBe("in_review");
    });

    it("posts the review as a peer comment without touching the work thread or status", async () => {
      const issue = reviewedIssue();
      const seen: boolean[] = [];
      const done = startPeerReview(issue.id, "GPT-6.1", async () => {
        seen.push(peerReviewOf(issue.id)?.state === "running");
        return { text: "Verdict: needs changes", sessionId: "review-thread" };
      });
      await done;
      expect(seen).toEqual([true]);
      expect(peerReviewOf(issue.id)).toBeUndefined();
      const stored = loadLocalIssues()[0];
      expect(stored).toMatchObject({
        status: "in_review",
        sessionId: "work-thread",
        runState: "completed",
      });
      expect(stored.runKind).toBeUndefined();
      expect(stored.reviews).toHaveLength(3);
      expect(stored.reviews!.at(-1)).toMatchObject({
        kind: "peer",
        model: "GPT-6.1",
        sessionId: "review-thread",
        text: "Verdict: needs changes",
      });
      expect(stored.activity.at(-1)?.text).toBe("Review by GPT-6.1 posted");
      // A later feedback run still resumes the original thread.
      expect(stored.sessionId).toBe("work-thread");
    });

    it("records a failed or cancelled review without posting or moving the issue", async () => {
      const issue = reviewedIssue();
      await startPeerReview(issue.id, "GPT-6.1", async () => {
        throw new Error("The review was stopped before it finished.");
      });
      expect(peerReviewOf(issue.id)).toEqual({
        state: "failed",
        model: "GPT-6.1",
        error: "The review was stopped before it finished.",
      });
      const stored = loadLocalIssues()[0];
      expect(stored.reviews).toHaveLength(2);
      expect(stored).toMatchObject({
        status: "in_review",
        sessionId: "work-thread",
        runState: "completed",
      });
      expect(stored.activity.at(-1)?.text).toContain("failed");
      // Retrying is allowed and clears the failure.
      await startPeerReview(issue.id, "GPT-6.1", async () => ({
        text: "ok",
        sessionId: "r2",
      }));
      expect(peerReviewOf(issue.id)).toBeUndefined();
      expect(loadLocalIssues()[0].reviews).toHaveLength(3);
    });

    it("refuses while the agent is working or before any work exists, and never runs twice", async () => {
      const issue = reviewedIssue();
      const review = vi.fn(async () => ({ text: "x", sessionId: "r" }));
      updateLocalIssue(issue.id, { runState: "running" });
      await expect(startPeerReview(issue.id, "M", review)).rejects.toThrow();
      updateLocalIssue(issue.id, { runState: "completed" });
      let release!: () => void;
      const first = startPeerReview(
        issue.id,
        "M",
        () =>
          new Promise((resolve) => {
            release = () => resolve({ text: "late", sessionId: "r" });
          }),
      );
      await startPeerReview(issue.id, "M", review);
      expect(review).not.toHaveBeenCalled();
      release();
      await first;
      expect(loadLocalIssues()[0].reviews).toHaveLength(3);
    });
  });
});
