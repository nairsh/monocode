import { limitSection } from "../../../shared/lib/jsonText";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
const RETIRED_STATUSES = ["canceled", "duplicate"];
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};
export const ISSUE_PRIORITIES = [
  "No priority",
  "Urgent",
  "High",
  "Medium",
  "Low",
] as const;
export type LocalIssue = {
  id: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  priority: number;
  projectPath: string;
  labels: string[];
  agent: HarnessId | "";
  model?: string;
  modelSettings?: Record<string, string>;
  images?: import("./localIssueImages").IssueImage[];
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  sessionId?: string;
  runState?: "starting" | "running" | "completed" | "failed" | "cancelled";
  runError?: string;
  runKind?: "work" | "commit";
  /** Window that owns the active run; other windows leave it alone while its heartbeat is fresh. */
  runOwner?: string;
  runHeartbeatAt?: string;
  feedback?: string;
  reviews?: {
    id: string;
    text: string;
    at: string;
    /** "peer" is another model's review; it never counts as the agent's own work. */
    kind: "work" | "commit" | "peer";
    /** Reviewer model name and thread, for kind "peer". */
    model?: string;
    sessionId?: string;
    images?: import("./localIssueImages").IssueImage[];
    evidenceError?: string;
  }[];
  activity: { id: string; text: string; at: string }[];
};
export type IssueDraft = Pick<
  LocalIssue,
  | "title"
  | "description"
  | "status"
  | "priority"
  | "projectPath"
  | "labels"
  | "agent"
  | "model"
  | "modelSettings"
  | "images"
>;
export const LOCAL_ISSUES_KEY = "monocode.localIssues.v1";
/** Identifies this window's runs; every window shares the same localStorage. */
export const ISSUE_WINDOW_ID = crypto.randomUUID();
export const ISSUE_HEARTBEAT_MS = 10_000;
export const ISSUE_RECOVERY_MS = 30_000;
const STALE_HEARTBEAT_MS = 45_000;
const STARTING_TIMEOUT_MS = 120_000;
const MAX_ACTIVITY = 200;
const PROMPT_ACTIVITY = 20;
const MAX_REVIEW_CHARS = 20_000;
/** A commit exists when git HEAD moved; the agent's wording is not proof. */
export function verifiedIssueCommit(
  previousHead: string | null | undefined,
  head: string | null | undefined,
): boolean {
  return Boolean(head && head !== previousHead);
}
export const capReviewText = (text: string) =>
  text.length > MAX_REVIEW_CHARS
    ? `${text.slice(0, MAX_REVIEW_CHARS)}\n\n… truncated; open the thread for the full reply`
    : text;
const CHANGE_EVENT = "monocode:local-issues-changed";

export function loadLocalIssues(): LocalIssue[] {
  const raw = localStorage.getItem(LOCAL_ISSUES_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(validIssue)) {
    throw new Error(
      "The local issue store could not be read. Your saved data has been preserved.",
    );
  }
  // Retired columns remain recoverable in the archive.
  return parsed.map((issue) =>
    RETIRED_STATUSES.includes(issue.status as string)
      ? { ...issue, status: "backlog" as const, archived: true }
      : issue,
  );
}

const validImages = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (image) =>
      image &&
      typeof image.id === "string" &&
      typeof image.name === "string" &&
      typeof image.mimeType === "string" &&
      typeof image.size === "number",
  );

export const isIssueRunning = (issue: Pick<LocalIssue, "runState">) =>
  issue.runState === "starting" || issue.runState === "running";

const cleanLabels = (labels: string[]) => [
  ...new Set(labels.map((label) => label.trim()).filter(Boolean)),
];

function validIssue(value: unknown): value is LocalIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as LocalIssue;
  return (
    typeof issue.id === "string" &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    [
      issue.title,
      issue.description,
      issue.projectPath,
      issue.createdAt,
      issue.updatedAt,
    ].every((value) => typeof value === "string") &&
    (ISSUE_STATUSES.includes(issue.status) ||
      RETIRED_STATUSES.includes(issue.status as string)) &&
    Number.isInteger(issue.priority) &&
    issue.priority >= 0 &&
    issue.priority <= 4 &&
    (issue.agent === "" || HARNESSES.includes(issue.agent)) &&
    (issue.model === undefined || typeof issue.model === "string") &&
    (issue.feedback === undefined || typeof issue.feedback === "string") &&
    (issue.runOwner === undefined || typeof issue.runOwner === "string") &&
    (issue.runHeartbeatAt === undefined ||
      typeof issue.runHeartbeatAt === "string") &&
    (issue.runKind === undefined ||
      ["work", "commit"].includes(issue.runKind)) &&
    (issue.reviews === undefined ||
      (Array.isArray(issue.reviews) &&
        issue.reviews.every(
          (review) =>
            review &&
            typeof review.id === "string" &&
            typeof review.text === "string" &&
            typeof review.at === "string" &&
            ["work", "commit", "peer"].includes(review.kind) &&
            (review.model === undefined || typeof review.model === "string") &&
            (review.sessionId === undefined ||
              typeof review.sessionId === "string") &&
            (review.images === undefined || validImages(review.images)),
        ))) &&
    (issue.modelSettings === undefined ||
      (typeof issue.modelSettings === "object" &&
        issue.modelSettings !== null &&
        Object.values(issue.modelSettings).every(
          (value) => typeof value === "string",
        ))) &&
    (issue.images === undefined || validImages(issue.images)) &&
    Array.isArray(issue.labels) &&
    issue.labels.every((value) => typeof value === "string") &&
    Array.isArray(issue.activity) &&
    issue.activity.every(
      (value) =>
        typeof value.id === "string" &&
        typeof value.text === "string" &&
        typeof value.at === "string",
    )
  );
}

function save(issues: LocalIssue[]) {
  // Write before notifying React: quota/storage failures must never look like a successful save.
  localStorage.setItem(LOCAL_ISSUES_KEY, JSON.stringify(issues));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeLocalIssues(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === LOCAL_ISSUES_KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", storage);
  };
}

export function createLocalIssue(draft: IssueDraft): LocalIssue {
  if (!draft.title.trim()) throw new Error("Give the issue a title.");
  const issues = loadLocalIssues();
  const at = new Date().toISOString();
  const issue: LocalIssue = {
    ...draft,
    title: draft.title.trim(),
    labels: cleanLabels(draft.labels),
    id: crypto.randomUUID(),
    number: Math.max(0, ...issues.map((issue) => issue.number)) + 1,
    createdAt: at,
    updatedAt: at,
    activity: [
      {
        id: crypto.randomUUID(),
        text: "Created the issue",
        at,
      },
    ],
  };
  if (!validIssue(issue)) throw new Error("Some issue details are invalid.");
  save([...issues, issue]);
  return issue;
}

export function updateLocalIssue(
  id: string,
  patch: Partial<Omit<LocalIssue, "id" | "number" | "createdAt" | "activity">>,
  message?: string,
): LocalIssue {
  const issues = loadLocalIssues();
  const index = issues.findIndex((issue) => issue.id === id);
  if (index < 0) throw new Error("This issue no longer exists.");
  const previous = issues[index]!;
  if (
    !message &&
    Object.entries(patch).every(
      ([key, value]) =>
        JSON.stringify(previous[key as keyof LocalIssue]) ===
        JSON.stringify(value),
    )
  )
    return previous;
  const at = new Date().toISOString();
  const text =
    message ??
    (patch.status && patch.status !== previous.status
      ? `Moved from ${ISSUE_STATUS_LABELS[previous.status]} to ${ISSUE_STATUS_LABELS[patch.status]}`
      : undefined);
  const next = {
    ...previous,
    ...patch,
    ...(patch.labels ? { labels: cleanLabels(patch.labels) } : {}),
    ...(patch.reviews
      ? {
          reviews: patch.reviews.map((review) => ({
            ...review,
            text: capReviewText(review.text),
          })),
        }
      : {}),
    updatedAt: at,
    activity: text
      ? [...previous.activity, { id: crypto.randomUUID(), text, at }].slice(
          -MAX_ACTIVITY,
        )
      : previous.activity,
  };
  if (!next.title.trim() || !validIssue(next))
    throw new Error("Some issue details are invalid.");
  issues[index] = next;
  save(issues);
  return next;
}

export function localIssuePrompt(issue: LocalIssue): string {
  return [
    `Work on local issue MC-${issue.number}: ${issue.title}`,
    `Status: ${ISSUE_STATUS_LABELS[issue.status]}\nPriority: ${ISSUE_PRIORITIES[issue.priority]}\nProject: ${issue.projectPath}\nLabels: ${issue.labels.join(", ") || "None"}\nAgent: ${issue.agent || "Project default"}`,
    `Created: ${issue.createdAt}\nUpdated: ${issue.updatedAt}`,
    `## Supporting details\n${issue.description.trim() || "No additional details."}`,
    `## Activity\n${issue.activity
      .slice(-PROMPT_ACTIVITY)
      .map((entry) => `${entry.at}: ${entry.text}`)
      .join("\n")}`,
    `Model: ${issue.model || "Project default"}\nModel options: ${JSON.stringify(issue.modelSettings || {})}`,
    issue.images?.length
      ? `## Attached images\n${issue.images.map((image) => image.name).join("\n")}\nUse the attached images as supporting context for this issue.`
      : "",
    "Complete the work described by the title and description and validate it. Do not commit yet: wait for review approval. In your final response, explain the changes, tests, and remaining blockers. Include proof using Markdown image links to absolute screenshot paths and links to relevant files or artifacts. Capture evidence when practical; never claim evidence you did not produce.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Feedback resumes the same thread, which already holds the full issue prompt.
export const localIssueFeedbackPrompt = (issue: LocalIssue, feedback: string) =>
  `Continue local issue MC-${issue.number}: ${issue.title} in this same thread.\n\nReview feedback:\n${feedback}\n\nAddress the feedback and validate it. Do not commit yet: wait for review approval. In your final response, explain the changes, tests, and remaining blockers. Include proof using Markdown image links to absolute screenshot paths; never claim evidence you did not produce.`;

export const hasWorkReview = (issue: Pick<LocalIssue, "reviews">) =>
  issue.reviews?.some((review) => review.kind === "work") ?? false;

/** Ends a run without stranding the issue: reviewed work returns to In Review. */
export function issueRunFailurePatch(
  issue: LocalIssue,
  runState: "failed" | "cancelled",
  runError?: string,
): Partial<LocalIssue> {
  return {
    runState,
    runError,
    runOwner: undefined,
    runHeartbeatAt: undefined,
    // Reviewed work (feedback or commit runs) goes back to review; a first run goes back to To Do.
    status:
      issue.runKind === "commit" || issue.feedback || hasWorkReview(issue)
        ? ("in_review" as const)
        : ("todo" as const),
  };
}

export type PeerReviewState = {
  state: "running" | "failed";
  model: string;
  error?: string;
};
// In memory on purpose: a review is not a run. It has no lease, so it must not
// touch runState/status (recovery would fail it), and a restart simply forgets it.
const peerReviews = new Map<string, PeerReviewState>();
export const peerReviewOf = (id: string) => peerReviews.get(id);
function setPeerReview(id: string, state?: PeerReviewState) {
  if (state) peerReviews.set(id, state);
  else peerReviews.delete(id);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Another model can review once the agent has produced work and is idle. */
export const canPeerReview = (
  issue: Pick<LocalIssue, "sessionId" | "reviews" | "runState">,
) => !!issue.sessionId && hasWorkReview(issue) && !isIssueRunning(issue);

/** Compact and self-contained: the reviewer never sees the original transcript. */
export function peerReviewPrompt(
  issue: LocalIssue,
  diff: { summary: string; patch: string },
): string {
  const work = [...(issue.reviews ?? [])]
    .reverse()
    .find((review) => review.kind === "work");
  return [
    `Review the work another agent did for local issue MC-${issue.number} in this working copy. This is read-only: do not modify, stage, or commit any files.`,
    `## Issue\n${issue.title}\n\n${limitSection(issue.description.trim() || "(no description)", 1_500)}`,
    `## The agent's summary of its work\n${limitSection(work?.text.trim() || "(none)", 2_000)}`,
    `## Changed files\n${limitSection(diff.summary.trim() || "(none)", 1_500)}`,
    `## Diff\nUntracked files appear by name only; read them if needed.\n\`\`\`diff\n${limitSection(diff.patch.trim() || "(no uncommitted changes)", 12_000)}\n\`\`\``,
    'Reply with a concise review. First line: "Verdict: approve" or "Verdict: needs changes". Then at most 10 bullets, most severe first, each with file:line and the concrete fix. No praise and no restating the diff. Open other files only when the diff is not enough.',
  ].join("\n\n");
}

/**
 * Runs `review` and posts its text as a "peer" review. Only `reviews` is
 * patched: sessionId (the original work thread), status, and run fields stay.
 */
export async function startPeerReview(
  id: string,
  model: string,
  review: (issue: LocalIssue) => Promise<{ text: string; sessionId: string }>,
): Promise<void> {
  const issue = loadLocalIssues().find((issue) => issue.id === id);
  if (!issue) throw new Error("This issue no longer exists.");
  if (peerReviews.get(id)?.state === "running") return;
  if (!canPeerReview(issue))
    throw new Error("Review is available once the agent has finished work.");
  setPeerReview(id, { state: "running", model });
  try {
    const result = await review(issue);
    const current = loadLocalIssues().find((issue) => issue.id === id);
    if (!current) throw new Error("This issue no longer exists.");
    updateLocalIssue(
      id,
      {
        reviews: [
          ...(current.reviews ?? []),
          {
            id: crypto.randomUUID(),
            text:
              result.text.trim() ||
              "The reviewer finished without a written review. Open its thread for details.",
            at: new Date().toISOString(),
            kind: "peer",
            model,
            sessionId: result.sessionId,
          },
        ],
      },
      `Review by ${model} posted`,
    );
    setPeerReview(id);
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : String(reason);
    setPeerReview(id, { state: "failed", model, error });
    try {
      updateLocalIssue(id, {}, `Review with ${model} failed: ${error}`);
    } catch {
      // The issue is gone or storage is unavailable; the failure state above still shows.
    }
  }
}

// Synchronous reservation is persisted before any async work to prevent duplicate launches.
export async function startLocalIssue(
  id: string,
  launch: (issue: LocalIssue) => Promise<void>,
  options?: { feedback?: string; kind?: "work" | "commit" },
): Promise<void> {
  const issue = loadLocalIssues().find((issue) => issue.id === id);
  if (!issue) throw new Error("This issue no longer exists.");
  if (isIssueRunning(issue)) return;
  if (!issue.projectPath || issue.projectPath === "~")
    throw new Error(
      "Choose a project before assigning this issue to an agent.",
    );
  const reserved = updateLocalIssue(
    id,
    {
      // Approval is final: the issue is Done while the commit run proceeds.
      status:
        options?.kind === "commit" ? "done" : options ? "in_progress" : "todo",
      runState: "starting",
      runError: undefined,
      runKind: options?.kind ?? "work",
      runOwner: ISSUE_WINDOW_ID,
      runHeartbeatAt: new Date().toISOString(),
      feedback: options?.feedback,
    },
    options?.kind === "commit"
      ? "Approved review; moved to Done and preparing commit"
      : options?.feedback
        ? `Review feedback: ${options.feedback}`
        : "Assigned to agent; preparing the issue thread",
  );
  try {
    await launch(reserved);
  } catch (error) {
    updateLocalIssue(
      id,
      issueRunFailurePatch(
        loadLocalIssues().find((issue) => issue.id === id) ?? reserved,
        "failed",
        error instanceof Error ? error.message : String(error),
      ),
      "Agent could not start; retry is available",
    );
    throw error;
  }
}

export async function moveLocalIssue(
  id: string,
  status: IssueStatus,
  launch?: (issue: LocalIssue) => Promise<void>,
) {
  const previous = loadLocalIssues().find((issue) => issue.id === id);
  if (!previous) throw new Error("This issue no longer exists.");
  if (isIssueRunning(previous)) {
    if (previous.status === status) return;
    throw new Error(
      "The agent is working. Stop its thread before changing the issue status.",
    );
  }
  if (previous.status === status) return;
  if (status === "in_progress")
    throw new Error(
      "In Progress is set when an agent starts. Move the issue to To Do to dispatch it, or send review feedback.",
    );
  if (status === "todo") {
    if (!launch)
      throw new Error(
        `Agent dispatch is unavailable. The issue is still in ${ISSUE_STATUS_LABELS[previous.status]}.`,
      );
    await startLocalIssue(id, launch);
  } else if (status === "done") {
    updateLocalIssue(id, { status }, "Marked done without a commit");
  } else {
    updateLocalIssue(id, { status });
  }
}

export function touchIssueRunLeases(
  windowId = ISSUE_WINDOW_ID,
  now = Date.now(),
): boolean {
  const heartbeat = new Date(now).toISOString();
  let changed = false;
  // Not updateLocalIssue: a lease refresh is neither activity nor an edit.
  const issues = loadLocalIssues().map((issue) => {
    if (!isIssueRunning(issue) || issue.runOwner !== windowId) return issue;
    changed = true;
    return { ...issue, runHeartbeatAt: heartbeat };
  });
  if (changed) save(issues);
  return changed;
}

const age = (now: number, at: string | undefined) => {
  const time = at ? Date.parse(at) : NaN;
  return Number.isNaN(time) ? Infinity : now - time;
};

/** Runs that no live agent backs. Another window's run is left alone while its heartbeat is fresh. */
export function staleIssueRuns(
  issues: LocalIssue[],
  now: number,
  windowId: string,
  isSessionRunning: (id: string | undefined) => boolean,
): { issue: LocalIssue; error: string }[] {
  const stale: { issue: LocalIssue; error: string }[] = [];
  for (const issue of issues) {
    if (!isIssueRunning(issue) || isSessionRunning(issue.sessionId)) continue;
    if (issue.runOwner === windowId) {
      if (issue.runState === "running")
        stale.push({
          issue,
          error:
            "The agent stopped without reporting a result. Review its saved thread before retrying.",
        });
      else if (age(now, issue.updatedAt) > STARTING_TIMEOUT_MS)
        stale.push({ issue, error: "The agent never started." });
    } else if (age(now, issue.runHeartbeatAt) > STALE_HEARTBEAT_MS) {
      stale.push({
        issue,
        error:
          "The app restarted during this issue run. Review its saved thread before retrying.",
      });
    }
  }
  return stale;
}

export function recoverLocalIssueRuns(
  isSessionRunning: (id: string | undefined) => boolean,
  now = Date.now(),
  windowId = ISSUE_WINDOW_ID,
) {
  for (const { issue, error } of staleIssueRuns(
    loadLocalIssues(),
    now,
    windowId,
    isSessionRunning,
  ))
    updateLocalIssue(
      issue.id,
      issueRunFailurePatch(issue, "failed", error),
      "Issue run interrupted; the saved thread is available for review",
    );
}
