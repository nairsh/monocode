import { invoke } from "@tauri-apps/api/core";
import {
  isIssueRunning,
  issueBlockers,
  loadLocalIssues,
  startLocalIssue,
  updateLocalIssues,
  validateIssueDependencies,
  type LocalIssue,
} from "./localIssues";

export type TriagePlan = {
  groups: {
    title: string;
    reason: string;
    files: string[];
    issueIds: string[];
  }[];
  dependencies: { issueId: string; dependsOn: string; reason: string }[];
};
export type TriagePreview = { plan: TriagePlan; snapshot: LocalIssue[] };

export function validateTriagePlan(
  value: unknown,
  snapshot: LocalIssue[],
): TriagePlan {
  const plan = value as TriagePlan;
  const ids = new Set(snapshot.map((issue) => issue.id));
  const assigned = new Set<string>();
  if (!plan || !Array.isArray(plan.groups) || !Array.isArray(plan.dependencies))
    throw new Error("Triage returned an invalid plan.");
  for (const group of plan.groups) {
    if (
      !group ||
      typeof group.title !== "string" ||
      !group.title.trim() ||
      group.title.length > 120 ||
      typeof group.reason !== "string" ||
      !group.reason.trim() ||
      !Array.isArray(group.files) ||
      group.files.some(
        (file) =>
          typeof file !== "string" ||
          file.startsWith("/") ||
          file.includes("\\") ||
          file.split("/").includes(".."),
      ) ||
      !Array.isArray(group.issueIds) ||
      !group.issueIds.length
    )
      throw new Error("Triage returned an invalid group.");
    const projects = new Set<string>();
    for (const id of group.issueIds) {
      if (!ids.has(id) || assigned.has(id))
        throw new Error("Each backlog issue must appear in exactly one group.");
      assigned.add(id);
      projects.add(snapshot.find((issue) => issue.id === id)!.projectPath);
    }
    if (projects.size !== 1) throw new Error("A group cannot span projects.");
  }
  if (assigned.size !== ids.size)
    throw new Error("Triage omitted backlog issues. Retry triage.");
  const issues = loadLocalIssues();
  plan.groups.forEach((group, index) =>
    group.issueIds.forEach((id) => {
      const issue = issues.find((entry) => entry.id === id);
      if (issue)
        issue.triageGroup = {
          id: `proposed-${index}`,
          title: group.title,
          reason: group.reason,
          files: group.files,
        };
    }),
  );
  for (const dependency of plan.dependencies) {
    if (
      !dependency ||
      !ids.has(dependency.issueId) ||
      typeof dependency.reason !== "string" ||
      !dependency.reason.trim()
    )
      throw new Error("Triage returned an invalid dependency.");
    const issue = issues.find((entry) => entry.id === dependency.issueId);
    if (!issue) throw new Error("An issue no longer exists.");
    issue.dependsOn = [
      ...new Set([...(issue.dependsOn ?? []), dependency.dependsOn]),
    ];
  }
  validateIssueDependencies(issues);
  return plan;
}

/** Analyze each repository separately; one isolated workspace per repository. */
export async function triageBacklog(project?: string): Promise<TriagePreview> {
  const snapshot = loadLocalIssues().filter(
    (issue) =>
      !issue.archived &&
      issue.status === "backlog" &&
      !isIssueRunning(issue) &&
      !issue.sessionId &&
      !issue.runBatchId &&
      (!project || issue.projectPath === project),
  );
  if (!snapshot.length)
    throw new Error("There are no unassigned backlog issues to triage.");
  if (snapshot.some((issue) => !issue.projectPath || issue.projectPath === "~"))
    throw new Error("Choose a project for every backlog issue before triage.");
  const plan: TriagePlan = { groups: [], dependencies: [] };
  for (const cwd of new Set(snapshot.map((issue) => issue.projectPath))) {
    const result = await invoke<TriagePlan>("task_model_triage", {
      cwd,
      issues: snapshot.filter((issue) => issue.projectPath === cwd),
      context: loadLocalIssues()
        .filter((issue) => issue.projectPath === cwd && !issue.archived)
        .map(({ id, number, title, status, dependsOn }) => ({
          id,
          number,
          title,
          status,
          dependsOn,
        })),
    });
    plan.groups.push(...result.groups);
    plan.dependencies.push(...result.dependencies);
  }
  return { plan: validateTriagePlan(plan, snapshot), snapshot };
}

export function applyTriagePlan({ plan, snapshot }: TriagePreview) {
  const current = loadLocalIssues();
  for (const issue of snapshot) {
    const latest = current.find((entry) => entry.id === issue.id);
    if (
      !latest ||
      JSON.stringify(latest) !== JSON.stringify(issue) ||
      latest.status !== "backlog" ||
      latest.archived ||
      isIssueRunning(latest)
    )
      throw new Error(
        "Backlog issues changed during triage. Run triage again to use their latest details.",
      );
  }
  validateTriagePlan(plan, snapshot);
  const changes = plan.groups.flatMap((group) => {
    const { issueIds, ...details } = group;
    const triageGroup = { ...details, id: crypto.randomUUID() };
    return issueIds.map((id) => {
      const issue = current.find((entry) => entry.id === id)!;
      const dependencies = plan.dependencies.filter(
        (entry) => entry.issueId === id,
      );
      return {
        id,
        patch: {
          triageGroup,
          dependsOn: [
            ...new Set([
              ...(issue.dependsOn ?? []),
              ...dependencies.map((entry) => entry.dependsOn),
            ]),
          ],
        },
        message: `Triaged into ${group.title}: ${group.reason}${dependencies.length ? ` Dependencies: ${dependencies.map((entry) => entry.reason).join("; ")}` : ""}`,
      };
    });
  });
  updateLocalIssues(changes);
}

export async function startIssueGroup(
  groupId: string,
  launch: (issue: LocalIssue) => Promise<void>,
) {
  const all = loadLocalIssues();
  const issues = all.filter(
    (issue) =>
      issue.triageGroup?.id === groupId &&
      !issue.archived &&
      issue.status !== "done",
  );
  if (!issues.length) throw new Error("This group has no unfinished issues.");
  if (
    issues.some(
      (issue) =>
        isIssueRunning(issue) ||
        issue.sessionId ||
        issue.runBatchId ||
        issue.status !== "backlog",
    )
  )
    throw new Error(
      "Group dispatch requires fresh backlog issues. Resume existing assignments from their tickets.",
    );
  // Recheck the graph, since dependencies may have been edited after triage.
  validateIssueDependencies(all);
  const ids = issues.map((issue) => issue.id);
  const blockers = issues.flatMap((issue) => issueBlockers(issue, all, ids));
  if (blockers.length)
    throw new Error(
      `Blocked by ${[...new Set(blockers.map((issue) => `MC-${issue.number}`))].join(", ")}.`,
    );
  // Explicit choices must agree; unspecified choices inherit the selected group's agent.
  for (const key of ["agent", "model"] as const) {
    if (new Set(issues.map((issue) => issue[key]).filter(Boolean)).size > 1)
      throw new Error(
        "Choose the same agent and model for the grouped issues before starting.",
      );
  }
  const settings = issues.filter(
    (issue) => issue.modelSettings && Object.keys(issue.modelSettings).length,
  );
  if (
    new Set(
      settings.map((issue) =>
        JSON.stringify(Object.entries(issue.modelSettings!).sort()),
      ),
    ).size > 1
  )
    throw new Error(
      "Choose the same model options for the grouped issues before starting.",
    );
  const runBatchId = crypto.randomUUID();
  const reserved = updateLocalIssues(
    issues.map((issue) => ({
      id: issue.id,
      patch: {
        runBatchId,
        agent: issues.find((entry) => entry.agent)?.agent ?? "",
        model: issues.find((entry) => entry.model)?.model,
        modelSettings: settings[0]?.modelSettings,
      },
      message: "Assigned to one group thread",
    })),
  );
  await startLocalIssue(reserved[0]!.id, launch);
}
