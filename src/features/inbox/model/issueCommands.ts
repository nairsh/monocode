import { pathKey } from "../../../shared/lib/paths";
import type { Session } from "../../sessions/model/session";
import {
  createLocalIssue,
  isIssueRunning,
  ISSUE_STATUSES,
  loadLocalIssues,
  updateLocalIssue,
  type LocalIssue,
} from "./localIssues";

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${field} must be a nonempty string of at most ${max} characters.`,
    );
  return value.trim();
}
function strings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((entry) => typeof entry !== "string" || entry.length > 256)
  )
    throw new Error(`${field} must be an array of at most 100 strings.`);
  return [...new Set(value)];
}

/** CLI mutations go through the same synchronous store and graph checks as the UI. */
export function handleIssueCommand(
  source: Pick<Session, "id">,
  requestId: string,
  action: string,
  input: Record<string, unknown>,
  cwd: string,
) {
  const all = loadLocalIssues();
  const issues = all.filter(
    (issue) => pathKey(issue.projectPath) === pathKey(cwd),
  );
  const resolve = (value: unknown) => {
    const id = text(value, "issueId", 256);
    const found = issues.find(
      (issue) => issue.id === id || `MC-${issue.number}` === id.toUpperCase(),
    );
    if (!found) throw new Error("Issue was not found in this project.");
    return found;
  };
  const status = () => {
    if (!ISSUE_STATUSES.includes(input.status as LocalIssue["status"]))
      throw new Error("Invalid issue status.");
    return input.status as LocalIssue["status"];
  };
  const priority = () => {
    if (
      !Number.isInteger(input.priority) ||
      Number(input.priority) < 0 ||
      Number(input.priority) > 4
    )
      throw new Error("priority must be an integer from 0 to 4.");
    return Number(input.priority);
  };
  const boolean = (value: unknown) => {
    if (typeof value !== "boolean")
      throw new Error("archived must be a boolean.");
    return value;
  };
  if (action === "issues.list") {
    const selectedStatus = input.status === undefined ? undefined : status();
    const archived =
      input.archived === undefined ? false : boolean(input.archived);
    return {
      issues: issues
        .filter(
          (issue) =>
            !!issue.archived === archived &&
            (!selectedStatus || issue.status === selectedStatus),
        )
        .map(
          ({
            id,
            number,
            title,
            status,
            priority,
            labels,
            dependsOn,
            triageGroup,
            sessionId,
            runState,
          }) => ({
            id,
            identifier: `MC-${number}`,
            title,
            status,
            priority,
            labels,
            dependsOn: dependsOn ?? [],
            group: triageGroup?.title,
            sessionId,
            runState,
          }),
        ),
    };
  }
  if (action === "issues.create") {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
      throw new Error("Invalid request ID.");
    const id = `issue-${source.id}-${requestId}`;
    const existing = issues.find((issue) => issue.id === id);
    if (existing) return existing;
    return createLocalIssue(
      {
        title: text(input.title, "title", 300),
        description:
          input.description === undefined
            ? ""
            : text(input.description, "description", 50_000),
        priority: input.priority === undefined ? 0 : priority(),
        labels:
          input.labels === undefined ? [] : strings(input.labels, "labels"),
        status: "backlog",
        projectPath: cwd,
        agent: "",
      },
      id,
    );
  }
  const issue = resolve(input.issueId);
  if (action === "issues.get") return issue;
  if (action === "issues.comment")
    return updateLocalIssue(
      issue.id,
      {},
      `Agent comment: ${text(input.text, "text", 20_000)}`,
    );
  if (action !== "issues.update") throw new Error("Unknown issue action.");
  if (isIssueRunning(issue) && issue.sessionId !== source.id)
    throw new Error(
      "Another agent is working on this issue. Wait or stop its thread before changing it.",
    );
  const patch: Partial<LocalIssue> = {};
  if (input.title !== undefined) patch.title = text(input.title, "title", 300);
  if (input.description !== undefined) {
    if (
      typeof input.description !== "string" ||
      input.description.length > 50_000
    )
      throw new Error(
        "description must be a string of at most 50000 characters.",
      );
    patch.description = input.description;
  }
  if (input.status !== undefined) {
    patch.status = status();
    if (
      (issue.sessionId || issue.runBatchId || isIssueRunning(issue)) &&
      patch.status !== issue.status
    )
      throw new Error(
        "Assignment status is managed by its run and human review. Report individual results in issue-results, or comment with remaining blockers.",
      );
    if (patch.status === "in_progress")
      throw new Error(
        "In Progress is set when an agent starts. Status updates do not launch work.",
      );
  }
  if (input.priority !== undefined) patch.priority = priority();
  if (input.labels !== undefined)
    patch.labels = strings(input.labels, "labels");
  if (input.dependsOn !== undefined)
    patch.dependsOn = strings(input.dependsOn, "dependsOn").map(
      (id) => resolve(id).id,
    );
  if (input.archived !== undefined) {
    if (isIssueRunning(issue))
      throw new Error("Stop the issue's thread before archiving it.");
    patch.archived = boolean(input.archived);
  }
  if (!Object.keys(patch).length)
    throw new Error("Supply at least one issue property to update.");
  return updateLocalIssue(
    issue.id,
    patch,
    `Agent updated ${Object.keys(patch).join(", ")}`,
  );
}
