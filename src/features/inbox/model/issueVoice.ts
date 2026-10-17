import { pathKey } from "../../../shared/lib/paths";
import { handleIssueCommand } from "./issueCommands";
import {
  ISSUE_STATUSES,
  loadLocalIssues,
  startLocalIssue,
  type LocalIssue,
} from "./localIssues";

export type IssueVoiceAction = {
  action: "issues.create" | "issues.update" | "issues.start";
  input: Record<string, unknown>;
  startAgent?: boolean;
};
export type IssueVoicePlan = {
  actions: IssueVoiceAction[];
  snapshot: LocalIssue[];
  project: string;
  id: string;
};

/** Only these app tools are available to the voice planner. No shell execution. */
export function validateIssueVoicePlan(
  value: unknown,
  project: string,
  snapshot: LocalIssue[],
): IssueVoicePlan {
  const rawActions = (value as { actions?: unknown })?.actions;
  if (
    !project ||
    !Array.isArray(rawActions) ||
    !rawActions.length ||
    rawActions.length > 20
  )
    throw new Error(
      "Choose a project and request between 1 and 20 issue actions.",
    );
  const actions = rawActions.map(
    (entry) =>
      entry && {
        ...entry,
        input:
          entry.input &&
          typeof entry.input === "object" &&
          !Array.isArray(entry.input)
            ? { ...entry.input }
            : entry.input,
      },
  );
  const scoped = snapshot.filter(
    (issue) =>
      pathKey(issue.projectPath) === pathKey(project) && !issue.archived,
  );
  for (const entry of actions) {
    if (
      !entry ||
      !["issues.create", "issues.update", "issues.start"].includes(
        entry.action,
      ) ||
      !entry.input ||
      typeof entry.input !== "object" ||
      Array.isArray(entry.input) ||
      (entry.startAgent !== undefined &&
        (entry.action !== "issues.create" ||
          typeof entry.startAgent !== "boolean"))
    )
      throw new Error("The command contains an unsupported action.");
    const input = entry.input as Record<string, unknown>;
    const allowed =
      entry.action === "issues.create"
        ? ["title", "description", "priority", "labels"]
        : entry.action === "issues.start"
          ? ["issueId"]
          : ["issueId", "title", "description", "status", "priority", "labels"];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      throw new Error("The command contains an unsupported issue property.");
    if (entry.action !== "issues.create") {
      const issue = scoped.find(
        (issue) =>
          issue.id === input.issueId ||
          `MC-${issue.number}` === String(input.issueId).toUpperCase(),
      );
      if (!issue)
        throw new Error("An issue was not found in the selected project.");
      // Normalize without modifying provider-owned input or the issue snapshot.
      entry.input = { ...input, issueId: issue.id };
    }
    if (
      entry.action === "issues.create" &&
      (typeof input.title !== "string" || !input.title.trim())
    )
      throw new Error("A new issue needs a title.");
    for (const [key, limit] of [
      ["title", 300],
      ["description", 50_000],
    ] as const) {
      if (
        input[key] !== undefined &&
        (typeof input[key] !== "string" ||
          input[key].length > limit ||
          (key === "title" && !input[key].trim()))
      )
        throw new Error(`Invalid ${key}.`);
    }
    if (
      input.priority !== undefined &&
      (!Number.isInteger(input.priority) ||
        Number(input.priority) < 0 ||
        Number(input.priority) > 4)
    )
      throw new Error("Priority must be between 0 and 4.");
    if (
      input.status !== undefined &&
      (!ISSUE_STATUSES.includes(input.status as LocalIssue["status"]) ||
        input.status === "in_progress")
    )
      throw new Error("Use Start agent to move an issue into progress.");
    if (
      input.labels !== undefined &&
      (!Array.isArray(input.labels) ||
        input.labels.length > 100 ||
        input.labels.some(
          (label) => typeof label !== "string" || label.length > 256,
        ))
    )
      throw new Error("Invalid labels.");
    if (entry.action === "issues.update" && Object.keys(input).length < 2)
      throw new Error("Choose a property to change.");
  }
  return {
    actions: actions.map((entry) => ({ ...entry, input: { ...entry.input } })),
    snapshot: structuredClone(scoped),
    project,
    id: crypto.randomUUID(),
  };
}

/** Rechecks scope and freshness before using the same tools and dispatch as the board. */
export async function applyIssueVoicePlan(
  plan: IssueVoicePlan,
  launch?: (issue: LocalIssue) => Promise<void>,
  onApplied?: (index: number) => void,
) {
  const current = loadLocalIssues();
  const targets = plan.actions
    .filter((action) => action.action !== "issues.create")
    .map((action) => String(action.input.issueId));
  for (const id of targets) {
    const before = plan.snapshot.find((issue) => issue.id === id);
    const now = current.find((issue) => issue.id === id);
    if (
      !before ||
      !now ||
      pathKey(now.projectPath) !== pathKey(plan.project) ||
      JSON.stringify(before) !== JSON.stringify(now)
    )
      throw new Error(
        "An issue changed after preview. Review the command again.",
      );
  }
  if (
    !launch &&
    plan.actions.some(
      (action) => action.action === "issues.start" || action.startAgent,
    )
  )
    throw new Error("Agent dispatch is unavailable.");
  for (const [index, action] of plan.actions.entries()) {
    if (action.action === "issues.start")
      await startLocalIssue(String(action.input.issueId), launch!);
    else {
      const issue = handleIssueCommand(
        { id: `voice-${plan.id}` },
        `action-${index}`,
        action.action,
        action.input,
        plan.project,
      ) as LocalIssue;
      if (action.startAgent) await startLocalIssue(issue.id, launch!);
    }
    onApplied?.(index);
  }
}

/** Fast, explicit commands work without sending a turn to a model. */
export function explicitIssueVoiceCommand(text: string): unknown | undefined {
  const command = text.trim().replace(/[.!]$/, "");
  const start = /^(?:start|run)(?: an? agent (?:on|for))?\s+(MC-\d+)$/i.exec(
    command,
  );
  if (start)
    return {
      actions: [{ action: "issues.start", input: { issueId: start[1] } }],
    };
  const create =
    /^(?:create|add)(?: an?)? issue(?: called| titled)?\s+(.+)$/i.exec(command);
  if (create)
    return {
      actions: [{ action: "issues.create", input: { title: create[1] } }],
    };
  const update =
    /^(?:set|change|move)\s+(MC-\d+)(?:\s+priority)?\s+to\s+(.+)$/i.exec(
      command,
    );
  if (update) {
    const priority = ["none", "urgent", "high", "medium", "low"].indexOf(
      update[2].toLowerCase(),
    );
    const status =
      (
        {
          "to do": "todo",
          "in review": "review",
          cancelled: "canceled",
        } as Record<string, string>
      )[update[2].toLowerCase()] ?? update[2].toLowerCase();
    return {
      actions: [
        {
          action: "issues.update",
          input: {
            issueId: update[1],
            ...(priority >= 0 ? { priority } : { status }),
          },
        },
      ],
    };
  }
}
