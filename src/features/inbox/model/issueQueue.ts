import {
  loadLocalIssues,
  subscribeLocalIssues,
  updateLocalIssues,
  type LocalIssue,
} from "./localIssues";
import {
  eligibleForGroupStart,
  issueGroupReadiness,
  startIssueGroup,
} from "./issueTriage";

/** Queue whole groups, keeping the triage graph and one thread per group. */
export function queueIssueGroups(ids: string[]) {
  const all = loadLocalIssues();
  const groupIds = new Set(
    all
      .filter((issue) => ids.includes(issue.id) && !issue.archived)
      .map((issue) => issue.triageGroup?.id)
      .filter(Boolean),
  );
  const members = all.filter(
    (issue) =>
      groupIds.has(issue.triageGroup?.id) &&
      !issue.archived &&
      issue.status !== "done",
  );
  if (!members.length) throw new Error("Select a triaged group to start.");
  if (members.some((issue) => !eligibleForGroupStart(issue)))
    throw new Error(
      "Continue existing assignments from their issues or threads.",
    );
  updateLocalIssues(
    members.map((issue) => ({
      id: issue.id,
      patch: { status: "todo", dispatchQueued: true },
      message: "Queued the triage group",
    })),
  );
}

/** Ready groups launch independently; blocked groups retain their explicit queue request. */
export async function dispatchQueuedIssueGroups(
  launch: (issue: LocalIssue) => Promise<void>,
  onError: (reason: unknown) => void,
  shouldStop = () => false,
) {
  const groupIds = new Set(
    loadLocalIssues()
      .filter(
        (issue) =>
          issue.dispatchQueued && !issue.archived && issue.status === "todo",
      )
      .map((issue) => issue.triageGroup?.id)
      .filter((id): id is string => !!id),
  );
  for (const id of groupIds) {
    if (shouldStop()) return;
    const all = loadLocalIssues();
    const members = all.filter(
      (issue) =>
        issue.triageGroup?.id === id &&
        !issue.archived &&
        issue.status !== "done",
    );
    if (
      !members.some(
        (issue) => issue.dispatchQueued && issue.status === "todo",
      ) ||
      issueGroupReadiness(members, all)
    )
      continue;
    try {
      await startIssueGroup(id, launch, true);
    } catch (reason) {
      // A reservation or launch failure needs user attention, never a retry loop.
      const queued = loadLocalIssues().filter(
        (issue) => issue.triageGroup?.id === id && issue.dispatchQueued,
      );
      if (queued.length)
        updateLocalIssues(
          queued.map((issue) => ({
            id: issue.id,
            patch: {
              dispatchQueued: undefined,
              runError:
                reason instanceof Error ? reason.message : String(reason),
            },
            message:
              "Group could not start; start it again after resolving the error",
          })),
        );
      onError(reason);
    }
  }
}

/** Runs at app scope so queued groups continue while the board is closed. */
export function watchIssueQueue(
  launch: (issue: LocalIssue) => Promise<void>,
  onError: (reason: unknown) => void,
) {
  let stopped = false;
  let running = false;
  let dirty = false;
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try {
      do {
        dirty = false;
        await dispatchQueuedIssueGroups(launch, onError, () => stopped);
      } while (dirty && !stopped);
    } catch (reason) {
      onError(reason);
    } finally {
      running = false;
    }
  };
  const refresh = () => {
    dirty = true;
    // Batch a multi-card drop before choosing ready groups.
    queueMicrotask(() => void drain());
  };
  const unsubscribe = subscribeLocalIssues(refresh);
  refresh();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
