import {
  gitCommit,
  gitHistory,
  gitStageFile,
  gitStagedContext,
  gitUnstageFile,
} from "../../../platform/tauri/fs";
import {
  loadLocalIssues,
  issueCommitMeta,
  issueRunFailurePatch,
  latestWorkReview,
  updateLocalIssue,
  verifiedIssueCommit,
  type LocalIssue,
} from "./localIssues";
import { taskModelCommitMessage } from "../../settings/model/taskModel";

/** Whether approval can commit without an agent: recorded files and a configured task model. */
export const canCommitWithTaskModel = (
  issue: LocalIssue,
  taskModelConfigured: boolean,
) => taskModelConfigured && Boolean(issue.commitFiles?.length);

/**
 * Commits an approved issue without resuming its agent thread. Stages only the recorded files
 * (the index may be shared with other issues), asks the task model for the message, and
 * requires HEAD to move. Failures return the issue to review instead of throwing.
 */
export async function commitIssueWithTaskModel(
  issue: LocalIssue,
  cwd: string,
): Promise<void> {
  const files = issue.commitFiles ?? [];
  const staged: string[] = [];
  let committed = false;
  try {
    updateLocalIssue(
      issue.id,
      { runState: "running", runHeartbeatAt: new Date().toISOString() },
      "Committing with the task model",
    );
    const previousHead = (await gitHistory(cwd, 1)).head;
    for (const file of files) {
      await gitStageFile(cwd, file);
      staged.push(file);
    }
    const context = await gitStagedContext(cwd);
    const message = await taskModelCommitMessage({
      title: issue.title,
      workSummary: latestWorkReview(issue)?.text ?? "",
      stat: context.summary,
      diff: context.patch,
      subjectHint: issue.commitSubject ?? "",
    });
    // Pathspec commit: another issue's staged files stay out of this commit.
    await gitCommit(cwd, message, false, files);
    committed = true;
    const history = await gitHistory(cwd, 10);
    if (!verifiedIssueCommit(previousHead, history.head))
      throw new Error("Git reported success but HEAD did not move.");
    const commit = history.commits.find((c) => c.sha === history.head);
    const sha = history.head!;
    const current = loadLocalIssues().find((e) => e.id === issue.id) ?? issue;
    updateLocalIssue(
      issue.id,
      {
        status: "done",
        runState: "completed",
        runError: undefined,
        runOwner: undefined,
        runHeartbeatAt: undefined,
        commitSha: sha,
        commitMeta: issueCommitMeta(commit, message.split("\n")[0]!),
        reviews: [
          ...(current.reviews ?? []),
          {
            id: crypto.randomUUID(),
            text: `Committed ${sha.slice(0, 7)} with the task model\n\n${message}`,
            at: new Date().toISOString(),
            kind: "commit",
          },
        ],
      },
      "Committed approved changes; issue done",
    );
  } catch (reason) {
    // Leave the shared index as we found it when no commit consumed the staged files.
    if (!committed)
      await Promise.all(
        staged.map((file) => gitUnstageFile(cwd, file).catch(() => {})),
      );
    const detail = reason instanceof Error ? reason.message : String(reason);
    updateLocalIssue(
      issue.id,
      issueRunFailurePatch(
        loadLocalIssues().find((e) => e.id === issue.id) ?? issue,
        "failed",
        `The commit could not be created: ${detail}. Retry, or send feedback.`,
      ),
      "Commit failed; back in review",
    );
  }
}
