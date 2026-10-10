import { limitSection } from "../../../shared/lib/jsonText";
import { pathKey } from "../../../shared/lib/paths";
import {
  HARNESSES,
  type Block,
  type HarnessId,
} from "../../sessions/model/session";

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
  parentIssueId?: string;
  /** Whether the agent should verify its work and provide supporting evidence. */
  verificationRequired?: boolean;
  dependsOn?: string[];
  /** Dependencies added by triage; manual prerequisites are retained on retriage. */
  triageDependencies?: string[];
  workOutcome?: { status: "ready" | "blocked" | "needs_work"; summary: string };
  triageGroup?: { id: string; title: string; reason: string; files: string[] };
  /** Issues in one assignment share its thread, review and commit. */
  runBatchId?: string;
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
  /** Repo-relative files the agent reported changing for this issue; the app stages exactly these on approval. */
  commitFiles?: string[];
  commitSubject?: string;
  commitSha?: string;
  commitMeta?: { subject: string; author: string; at: string };
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
  | "verificationRequired"
  | "agent"
  | "model"
  | "modelSettings"
  | "images"
  | "parentIssueId"
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
const COMMIT_FILES_FENCE = /```commit-files\r?\n([\s\S]*?)```/g;
const COMMIT_SUBJECT_LINE = /^Commit subject:[ \t]*(.+)$/gm;
export function sanitizeCommitFiles(files: string[]): string[] {
  return [
    ...new Set(
      files
        .map((line) =>
          line
            .replace(/^\s*[-*]\s+/, "")
            .replace(/[`"']/g, "")
            .trim(),
        )
        // Metadata is not a path, even when the agent puts it inside the file fence.
        .filter(
          (file) =>
            file &&
            !/^Commit subject:/i.test(file) &&
            !file.startsWith("/") &&
            !file.split("/").includes(".."),
        ),
    ),
  ];
}
/** Reads the commit plan the agent ends its reply with; the last block and line win. */
export function parseCommitPlan(text: string): {
  files: string[];
  subject?: string;
} {
  const block = [...text.matchAll(COMMIT_FILES_FENCE)].pop()?.[1] ?? "";
  const files = sanitizeCommitFiles(block.split("\n"));
  const subject = [...text.matchAll(COMMIT_SUBJECT_LINE)]
    .pop()?.[1]
    ?.replace(/^[`"']|[`"']$/g, "")
    .trim();
  return { files, subject: subject || undefined };
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
  return parsed.map((issue) => {
    // Repair plans saved by older versions so approval retries use only file paths.
    const repaired = issue.commitFiles
      ? { ...issue, commitFiles: sanitizeCommitFiles(issue.commitFiles) }
      : issue;
    return RETIRED_STATUSES.includes(issue.status as string)
      ? { ...repaired, status: "backlog" as const, archived: true }
      : repaired;
  });
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

export const isIssueResolved = (issue: LocalIssue) =>
  issue.status === "done" &&
  !isIssueRunning(issue) &&
  (!issue.sessionId || !!issue.commitSha) &&
  !(issue.runKind === "commit" && issue.runState !== "completed");

/** Pending review still owns the working copy: its edits have not been committed. */
export function repositoryAssignmentBlocker(
  issue: LocalIssue,
  all = loadLocalIssues(),
) {
  return all.find(
    (other) =>
      other.id !== issue.id &&
      !(issue.runBatchId && issue.runBatchId === other.runBatchId) &&
      pathKey(other.projectPath) === pathKey(issue.projectPath) &&
      (isIssueRunning(other) || !!other.sessionId) &&
      !isIssueResolved(other) &&
      !(
        other.archived &&
        all.some(
          (member) =>
            other.runBatchId &&
            member.runBatchId === other.runBatchId &&
            isIssueResolved(member),
        )
      ),
  );
}

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
    (issue.dependsOn === undefined ||
      (Array.isArray(issue.dependsOn) &&
        issue.dependsOn.every((id) => typeof id === "string"))) &&
    (issue.triageDependencies === undefined ||
      (Array.isArray(issue.triageDependencies) &&
        issue.triageDependencies.every((id) => typeof id === "string"))) &&
    (issue.workOutcome === undefined ||
      (["ready", "blocked", "needs_work"].includes(issue.workOutcome.status) &&
        typeof issue.workOutcome.summary === "string")) &&
    (issue.parentIssueId === undefined ||
      typeof issue.parentIssueId === "string") &&
    (issue.runBatchId === undefined || typeof issue.runBatchId === "string") &&
    (issue.triageGroup === undefined ||
      (typeof issue.triageGroup?.id === "string" &&
        typeof issue.triageGroup.title === "string" &&
        typeof issue.triageGroup.reason === "string" &&
        Array.isArray(issue.triageGroup.files) &&
        issue.triageGroup.files.every((file) => typeof file === "string"))) &&
    (issue.feedback === undefined || typeof issue.feedback === "string") &&
    (issue.verificationRequired === undefined ||
      typeof issue.verificationRequired === "boolean") &&
    (issue.commitSha === undefined || typeof issue.commitSha === "string") &&
    (issue.commitFiles === undefined ||
      (Array.isArray(issue.commitFiles) &&
        issue.commitFiles.every((file) => typeof file === "string"))) &&
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

/** Validate the whole graph before writing any dependency changes. */
export function validateIssueDependencies(issues: LocalIssue[]) {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues) {
    const ancestors = new Set([issue.id]);
    let parentId = issue.parentIssueId;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || pathKey(parent.projectPath) !== pathKey(issue.projectPath))
        throw new Error(
          "Sub-issues must belong to a parent in the same project.",
        );
      if (ancestors.has(parentId))
        throw new Error("Sub-issues cannot form a cycle.");
      ancestors.add(parentId);
      parentId = parent.parentIssueId;
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (issue: LocalIssue) => {
    if (visiting.has(issue.id))
      throw new Error("Issue dependencies cannot form a cycle.");
    if (visited.has(issue.id)) return;
    visiting.add(issue.id);
    for (const id of issue.dependsOn ?? []) {
      const dependency = byId.get(id);
      if (
        !dependency ||
        dependency.id === issue.id ||
        pathKey(dependency.projectPath) !== pathKey(issue.projectPath)
      )
        throw new Error(
          "Dependencies must reference another issue in the same project.",
        );
      visit(dependency);
    }
    visiting.delete(issue.id);
    visited.add(issue.id);
  };
  issues.forEach(visit);
  // An issue graph can be acyclic while two indivisible groups block each other.
  const groupOf = (issue: LocalIssue) =>
    issue.runBatchId ?? issue.triageGroup?.id ?? issue.id;
  const edges = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (isIssueResolved(issue)) continue;
    const group = groupOf(issue);
    if (!edges.has(group)) edges.set(group, new Set());
    for (const id of issue.dependsOn ?? []) {
      const dependency = byId.get(id)!;
      const prerequisite = groupOf(dependency);
      if (!isIssueResolved(dependency) && prerequisite !== group)
        edges.get(group)!.add(prerequisite);
    }
  }
  visiting.clear();
  visited.clear();
  const visitGroup = (group: string) => {
    if (visiting.has(group))
      throw new Error(
        "These assignments would block each other. Regroup the issues or remove the conflicting dependency.",
      );
    if (visited.has(group)) return;
    visiting.add(group);
    for (const dependency of edges.get(group) ?? []) visitGroup(dependency);
    visiting.delete(group);
    visited.add(group);
  };
  edges.forEach((_, group) => visitGroup(group));
}

/** One synchronous write keeps plans and group reservations all-or-nothing. */
export function updateLocalIssues(
  changes: { id: string; patch: Partial<LocalIssue>; message?: string }[],
): LocalIssue[] {
  const issues = loadLocalIssues();
  const at = new Date().toISOString();
  const byId = new Map(changes.map((change) => [change.id, change]));
  if (
    byId.size !== changes.length ||
    changes.some((change) => !issues.some((issue) => issue.id === change.id))
  )
    throw new Error("Some issues no longer exist.");
  const next = issues.map((issue) => {
    const change = byId.get(issue.id);
    if (!change) return issue;
    const updated = {
      ...issue,
      ...change.patch,
      id: issue.id,
      number: issue.number,
      createdAt: issue.createdAt,
      updatedAt: at,
      activity: change.message
        ? [
            ...issue.activity,
            { id: crypto.randomUUID(), text: change.message, at },
          ].slice(-MAX_ACTIVITY)
        : issue.activity,
    };
    if (!validIssue(updated) || !updated.title.trim())
      throw new Error("Some issue details are invalid.");
    return updated;
  });
  validateIssueDependencies(next);
  save(next);
  return next.filter((issue) => byId.has(issue.id));
}

export function issueBlockers(
  issue: LocalIssue,
  issues = loadLocalIssues(),
  included: readonly string[] = [],
) {
  return (issue.dependsOn ?? [])
    .filter((id) => !included.includes(id))
    .map((id) => issues.find((candidate) => candidate.id === id))
    .filter(
      (dependency): dependency is LocalIssue =>
        !!dependency && !isIssueResolved(dependency),
    );
}

export function issueAssignment(issue: LocalIssue): LocalIssue[] {
  return issue.runBatchId
    ? loadLocalIssues().filter(
        (candidate) =>
          candidate.runBatchId === issue.runBatchId &&
          !candidate.archived &&
          (!isIssueResolved(candidate) || candidate.id === issue.id),
      )
    : [issue];
}

/** Apply a shared run result while retaining each ticket's previous reviews. */
export function updateIssueAssignment(
  issue: LocalIssue,
  patch: Partial<LocalIssue>,
  message?: string,
  outcomes?: Record<string, NonNullable<LocalIssue["workOutcome"]>>,
): LocalIssue {
  const assignment = issueAssignment(issue);
  const current =
    assignment.find((candidate) => candidate.id === issue.id) ?? issue;
  const addedReviews = patch.reviews?.filter(
    (review) => !current.reviews?.some((entry) => entry.id === review.id),
  );
  return updateLocalIssues(
    assignment.map((candidate) => ({
      id: candidate.id,
      patch: {
        ...patch,
        ...(outcomes?.[candidate.id]
          ? {
              workOutcome: outcomes[candidate.id],
              status:
                outcomes[candidate.id].status === "ready"
                  ? ("in_review" as const)
                  : ("todo" as const),
            }
          : {}),
        ...(addedReviews
          ? {
              reviews: [...(candidate.reviews ?? []), ...addedReviews].map(
                (review) => ({ ...review, text: capReviewText(review.text) }),
              ),
            }
          : {}),
      },
      message,
    })),
  ).find((candidate) => candidate.id === issue.id)!;
}

/** Missing or malformed per-ticket results never imply that a grouped ticket is ready. */
export function parseIssueOutcomes(text: string, assignment: LocalIssue[]) {
  let results: Record<string, unknown> = {};
  try {
    const block = [
      ...text.matchAll(/```issue-results\s*\n([\s\S]*?)```/g),
    ].pop()?.[1];
    if (block) results = JSON.parse(block) ?? {};
  } catch {
    /* Display an actionable missing-result outcome below. */
  }
  return Object.fromEntries(
    assignment.map((issue) => {
      const result = results[`MC-${issue.number}`] as LocalIssue["workOutcome"];
      const valid =
        result &&
        ["ready", "blocked", "needs_work"].includes(result.status) &&
        typeof result.summary === "string";
      return [
        issue.id,
        valid
          ? result
          : {
              status:
                assignment.length === 1
                  ? ("ready" as const)
                  : ("needs_work" as const),
              summary:
                assignment.length === 1
                  ? "Ready for review."
                  : "No individual result reported. Request feedback or confirm this ticket is ready for review.",
            },
      ];
    }),
  );
}

export function localIssueAssignmentPrompt(issue: LocalIssue): string {
  const assignment = issueAssignment(issue);
  if (assignment.length === 1) return localIssuePrompt(issue);
  const ordered: LocalIssue[] = [];
  const visit = (candidate: LocalIssue) => {
    if (ordered.some((entry) => entry.id === candidate.id)) return;
    for (const id of candidate.dependsOn ?? []) {
      const dependency = assignment.find((entry) => entry.id === id);
      if (dependency) visit(dependency);
    }
    ordered.push(candidate);
  };
  assignment.forEach(visit);
  return [
    `Work on this group in one thread: ${issue.triageGroup?.title ?? "Related issues"}.`,
    "Only the tickets listed below are active in this assignment. Do not resume archived or completed former members.",
    "Complete every issue below, in the listed dependency order. Treat their combined changes as one review and commit plan. Do not spawn separate threads for these tickets. Report each ticket's result explicitly.",
    ...ordered.map(localIssuePrompt),
    'Finish with ONE combined commit-files block for the entire assignment, and an ```issue-results JSON block mapping EVERY MC-number to {"status":"ready"|"blocked"|"needs_work","summary":"Result or remaining blocker"}. Only mark a ticket ready when its requested work is complete. Do not treat a completed turn as completion of every ticket.',
  ].join("\n\n");
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

export function createLocalIssue(
  draft: IssueDraft,
  id: string = crypto.randomUUID(),
): LocalIssue {
  if (!draft.title.trim()) throw new Error("Give the issue a title.");
  const issues = loadLocalIssues();
  if (issues.some((issue) => issue.id === id))
    throw new Error("This issue already exists.");
  const at = new Date().toISOString();
  const issue: LocalIssue = {
    ...draft,
    title: draft.title.trim(),
    labels: cleanLabels(draft.labels),
    id,
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
  validateIssueDependencies([...issues, issue]);
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
    patch.projectPath !== undefined &&
    pathKey(patch.projectPath) !== pathKey(previous.projectPath)
  ) {
    if (previous.sessionId || previous.runBatchId || isIssueRunning(previous))
      throw new Error(
        "An assigned issue cannot change projects. Create a new ticket in the target project.",
      );
    patch = { ...patch, triageGroup: undefined, triageDependencies: undefined };
  }
  if (patch.dependsOn) {
    patch = {
      ...patch,
      triageDependencies: previous.triageDependencies?.filter((id) =>
        patch.dependsOn!.includes(id),
      ),
    };
  }
  if (patch.archived && isIssueRunning(previous))
    throw new Error("Stop the issue's thread before archiving it.");
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
  validateIssueDependencies(issues);
  save(issues);
  return next;
}

const COMMIT_PLAN_PROMPT =
  "List the paths, relative to your working directory, of every file you changed for this issue (including deletions), one per line, inside a ```commit-files fenced block. Put only file paths in that block and close it with ```. After the closing fence, on a separate line outside the block, write `Commit subject: <one-line conventional commit subject>`. Do not commit.";
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
    issue.dependsOn?.length
      ? `Depends on: ${issue.dependsOn
          .map((id) => {
            const dependency = loadLocalIssues().find(
              (candidate) => candidate.id === id,
            );
            return dependency
              ? `MC-${dependency.number} (${dependency.status})`
              : id;
          })
          .join(", ")}`
      : "",
    issue.images?.length
      ? `## Attached images\n${issue.images.map((image) => image.name).join("\n")}\nUse the attached images as supporting context for this issue.`
      : "",
    "Complete the work described by the title and description. Do not commit yet: wait for review approval. In your final response, explain the changes, any validation performed, and remaining blockers. Include links to relevant files or artifacts. Never claim evidence you did not produce. " +
      COMMIT_PLAN_PROMPT,
    issue.verificationRequired === false
      ? "Verification not required: No separate verification or supporting evidence is required for this issue."
      : "Verification required: Verify the completed work using appropriate methods, including computer or browser interaction when relevant, and provide supporting evidence in your final response.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Feedback resumes the same thread, which already holds the full issue prompt.
export const localIssueFeedbackPrompt = (issue: LocalIssue, feedback: string) =>
  `Continue local issue MC-${issue.number}: ${issue.title} in this same thread.\n\nReview feedback:\n${feedback}\n\nAddress the feedback and validate it. Do not commit yet: wait for review approval. In your final response, explain the changes, tests, and remaining blockers. Include proof using Markdown image links to absolute screenshot paths; never claim evidence you did not produce. ${COMMIT_PLAN_PROMPT}`;

export const hasWorkReview = (issue: Pick<LocalIssue, "reviews">) =>
  issue.reviews?.some((review) => review.kind === "work") ?? false;

/** The agent's newest own summary of its work, if any. */
export const latestWorkReview = (issue: Pick<LocalIssue, "reviews">) =>
  [...(issue.reviews ?? [])].reverse().find((review) => review.kind === "work");

/** Text of the newest visible assistant message, if any. */
export const lastAgentReply = (blocks: readonly Block[] = []) =>
  blocks
    .filter(
      (block) =>
        block.role === "assistant" && !block.internal && block.text.trim(),
    )
    .pop()?.text;

/** Commit details stored on an issue; `commit` is a git history entry, if the log could be read. */
export const issueCommitMeta = (
  commit: { subject: string; author: string; timestamp: number } | undefined,
  fallbackSubject: string,
) => ({
  subject: commit?.subject ?? fallbackSubject,
  author: commit?.author ?? "",
  at: new Date(commit ? commit.timestamp * 1000 : Date.now()).toISOString(),
});

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
  const work = latestWorkReview(issue);
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

/** Serialize reservations across app windows where Web Locks are available. */
export function withIssueDispatchLock<T>(
  dispatch: () => Promise<T>,
): Promise<T> {
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("monocode.issue-dispatch", dispatch)
    : dispatch();
}

export async function startLocalIssue(
  id: string,
  launch: (issue: LocalIssue) => Promise<void>,
  options?: { feedback?: string; kind?: "work" | "commit" },
): Promise<void> {
  return withIssueDispatchLock(() =>
    startReservedLocalIssue(id, launch, options),
  );
}

/** Caller holds the dispatch lock; persist reservations before invoking an agent. */
export async function startReservedLocalIssue(
  id: string,
  launch: (issue: LocalIssue) => Promise<void>,
  options?: { feedback?: string; kind?: "work" | "commit" },
): Promise<void> {
  const issue = loadLocalIssues().find((issue) => issue.id === id);
  if (!issue) throw new Error("This issue no longer exists.");
  if (issue.archived) throw new Error("Restore this issue before running it.");
  if (isIssueRunning(issue)) return;
  const assignment = issueAssignment(issue);
  if (
    assignment.some(
      (member) => pathKey(member.projectPath) !== pathKey(issue.projectPath),
    )
  )
    throw new Error("An assignment cannot span projects.");
  const occupied = repositoryAssignmentBlocker(issue);
  if (occupied)
    throw new Error(
      `Waiting for MC-${occupied.number}: finish and commit its assignment before starting more work in this repository.`,
    );
  if (assignment.some((candidate) => isIssueRunning(candidate)))
    throw new Error("This group's agent is already working.");
  const blockers = assignment.flatMap((candidate) =>
    issueBlockers(
      candidate,
      loadLocalIssues(),
      assignment.map((entry) => entry.id),
    ),
  );
  if (options?.kind !== "commit" && blockers.length)
    throw new Error(
      `Blocked by ${[...new Set(blockers.map((entry) => `MC-${entry.number}`))].join(", ")}. Complete those issues first.`,
    );
  if (
    options?.kind === "commit" &&
    assignment.some(
      (candidate) =>
        candidate.status !== "in_review" ||
        (candidate.workOutcome && candidate.workOutcome.status !== "ready"),
    )
  )
    throw new Error(
      "Every issue in the group must be in review before approving its shared commit.",
    );
  if (!issue.projectPath || issue.projectPath === "~")
    throw new Error(
      "Choose a project before assigning this issue to an agent.",
    );
  const reserved = updateLocalIssues(
    assignment.map((candidate) => ({
      id: candidate.id,
      patch: {
        // Dependencies remain blocked until the commit has actually succeeded.
        status:
          options?.kind === "commit"
            ? "in_review"
            : options
              ? "in_progress"
              : "todo",
        runState: "starting",
        runError: undefined,
        runKind: options?.kind ?? "work",
        runOwner: ISSUE_WINDOW_ID,
        runHeartbeatAt: new Date().toISOString(),
        feedback: options?.feedback,
        ...(options?.kind !== "commit"
          ? {
              workOutcome: undefined,
              commitSha: undefined,
              commitMeta: undefined,
            }
          : {}),
      },
      message:
        options?.kind === "commit"
          ? "Approved review; preparing commit"
          : options?.feedback
            ? `Review feedback: ${options.feedback}`
            : "Assigned to agent; preparing the issue thread",
    })),
  ).find((candidate) => candidate.id === id)!;
  try {
    await launch(reserved);
  } catch (error) {
    updateLocalIssues(
      issueAssignment(reserved).map((candidate) => ({
        id: candidate.id,
        patch: issueRunFailurePatch(
          candidate,
          "failed",
          error instanceof Error ? error.message : String(error),
        ),
        message: "Agent could not start; retry is available",
      })),
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
    if (previous.triageGroup && !previous.runBatchId)
      throw new Error(
        "This ticket belongs to a triage group. Use Start group, or detach the ticket in its details before starting it individually.",
      );
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
