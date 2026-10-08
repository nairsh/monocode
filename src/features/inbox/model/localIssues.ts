import { HARNESSES, type HarnessId } from "../../sessions/model/session";

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
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
  feedback?: string;
  reviews?: {
    id: string;
    text: string;
    at: string;
    kind: "work" | "commit";
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
export function verifiedIssueCommit(
  previousHead: string | null | undefined,
  head: string | null | undefined,
  output: string,
): boolean {
  return Boolean(
    head && head !== previousHead && output.includes(head.slice(0, 7)),
  );
}
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
    ["canceled", "duplicate"].includes(issue.status as string)
      ? { ...issue, status: "backlog" as const, archived: true }
      : issue,
  );
}

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
      ["canceled", "duplicate"].includes(issue.status as string)) &&
    Number.isInteger(issue.priority) &&
    issue.priority >= 0 &&
    issue.priority <= 4 &&
    (issue.agent === "" || HARNESSES.includes(issue.agent)) &&
    (issue.model === undefined || typeof issue.model === "string") &&
    (issue.feedback === undefined || typeof issue.feedback === "string") &&
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
            ["work", "commit"].includes(review.kind) &&
            (review.images === undefined ||
              (Array.isArray(review.images) &&
                review.images.every(
                  (image) =>
                    image &&
                    typeof image.id === "string" &&
                    typeof image.name === "string" &&
                    typeof image.mimeType === "string" &&
                    typeof image.size === "number",
                ))),
        ))) &&
    (issue.modelSettings === undefined ||
      (typeof issue.modelSettings === "object" &&
        issue.modelSettings !== null &&
        Object.values(issue.modelSettings).every(
          (value) => typeof value === "string",
        ))) &&
    (issue.images === undefined ||
      (Array.isArray(issue.images) &&
        issue.images.every(
          (image) =>
            image &&
            typeof image.id === "string" &&
            typeof image.name === "string" &&
            typeof image.mimeType === "string" &&
            typeof image.size === "number",
        ))) &&
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
    labels: [
      ...new Set(draft.labels.map((label) => label.trim()).filter(Boolean)),
    ],
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
    ...(patch.labels
      ? {
          labels: [
            ...new Set(
              patch.labels.map((label) => label.trim()).filter(Boolean),
            ),
          ],
        }
      : {}),
    updatedAt: at,
    activity: text
      ? [...previous.activity, { id: crypto.randomUUID(), text, at }]
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
    `## Activity\n${issue.activity.map((entry) => `${entry.at}: ${entry.text}`).join("\n")}`,
    `Model: ${issue.model || "Project default"}\nModel options: ${JSON.stringify(issue.modelSettings || {})}`,
    issue.images?.length
      ? `## Attached images\n${issue.images.map((image) => image.name).join("\n")}\nUse the attached images as supporting context for this issue.`
      : "",
    "Complete the work described by the title and description and validate it. Do not commit yet: wait for review approval. In your final response, explain the changes, tests, and remaining blockers. Include proof using Markdown image links to absolute screenshot paths and links to relevant files or artifacts. Capture evidence when practical; never claim evidence you did not produce.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Synchronous reservation is persisted before any async work to prevent duplicate launches.
export async function startLocalIssue(
  id: string,
  launch: (issue: LocalIssue) => Promise<void>,
  options?: { feedback?: string; kind?: "work" | "commit" },
): Promise<void> {
  const issue = loadLocalIssues().find((issue) => issue.id === id);
  if (!issue) throw new Error("This issue no longer exists.");
  if (issue.runState === "starting" || issue.runState === "running") return;
  if (!issue.projectPath || issue.projectPath === "~")
    throw new Error(
      "Choose a project before assigning this issue to an agent.",
    );
  const reserved = updateLocalIssue(
    id,
    {
      status: options ? "in_progress" : "todo",
      runState: "starting",
      runError: undefined,
      runKind: options?.kind ?? "work",
      feedback: options?.feedback,
    },
    options?.kind === "commit"
      ? "Approved review; preparing commit"
      : options?.feedback
        ? `Review feedback: ${options.feedback}`
        : "Assigned to agent; preparing the issue thread",
  );
  try {
    await launch(reserved);
  } catch (error) {
    updateLocalIssue(
      id,
      {
        runState: "failed",
        runError: error instanceof Error ? error.message : String(error),
      },
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
  if (previous.runState === "starting" || previous.runState === "running") {
    if (previous.status === status) return;
    throw new Error(
      "The agent is working. Stop its thread before changing the issue status.",
    );
  }
  if (previous.status === "backlog" && status === "todo") {
    if (!launch)
      throw new Error(
        "Agent dispatch is unavailable. The issue is still in Backlog.",
      );
    await startLocalIssue(id, launch);
  } else {
    updateLocalIssue(id, { status });
  }
}

export function recoverLocalIssueRuns(
  isSessionRunning: (id: string | undefined) => boolean,
) {
  for (const issue of loadLocalIssues()) {
    if (
      (issue.runState === "starting" || issue.runState === "running") &&
      !isSessionRunning(issue.sessionId)
    ) {
      updateLocalIssue(
        issue.id,
        {
          runState: "failed",
          runError:
            "The app restarted during this issue run. Review its saved thread before retrying.",
        },
        "Issue run interrupted; the saved thread is available for review",
      );
    }
  }
}
