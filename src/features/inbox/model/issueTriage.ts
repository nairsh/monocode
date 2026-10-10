import { pathKey } from "../../../shared/lib/paths";
import { loadIssueImages } from "./localIssueImages";
import { runTriageAgent } from "./triageAgent";
import { loadTriageModel } from "../../settings/model/triageModel";
import type { Attachment } from "../../sessions/model/session";
import {
  isIssueRunning,
  issueBlockers,
  repositoryAssignmentBlocker,
  loadLocalIssues,
  startReservedLocalIssue,
  withIssueDispatchLock,
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
export type TriagePreview = {
  plan: TriagePlan;
  snapshot: LocalIssue[];
  warnings?: string[];
};
const DRAFT_KEY = "monocode.issueTriage.draft.v1";
export function loadTriageDraft(): TriagePreview | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(DRAFT_KEY) ?? "null",
    ) as TriagePreview | null;
    if (
      !value ||
      !Array.isArray(value.snapshot) ||
      !Array.isArray(value.plan?.groups) ||
      !Array.isArray(value.plan?.dependencies)
    )
      return null;
    if (
      !value.snapshot.every(
        (issue) =>
          issue &&
          typeof issue.id === "string" &&
          typeof issue.projectPath === "string",
      )
    )
      return null;
    if (
      !value.plan.groups.every(
        (group) =>
          group &&
          typeof group.title === "string" &&
          typeof group.reason === "string" &&
          Array.isArray(group.files) &&
          group.files.every((file) => typeof file === "string") &&
          Array.isArray(group.issueIds) &&
          group.issueIds.length &&
          group.issueIds.every((id) =>
            value.snapshot.some((issue) => issue.id === id),
          ),
      )
    )
      return null;
    if (
      !value.plan.dependencies.every(
        (edge) =>
          edge &&
          typeof edge.issueId === "string" &&
          typeof edge.dependsOn === "string" &&
          typeof edge.reason === "string",
      )
    )
      return null;
    if (
      value.warnings &&
      (!Array.isArray(value.warnings) ||
        !value.warnings.every((warning) => typeof warning === "string"))
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function saveTriageDraft(value: TriagePreview | null) {
  if (value) localStorage.setItem(DRAFT_KEY, JSON.stringify(value));
  else localStorage.removeItem(DRAFT_KEY);
}
export const eligibleForTriage = (issue: LocalIssue) =>
  !issue.archived &&
  issue.status === "backlog" &&
  !isIssueRunning(issue) &&
  !issue.sessionId &&
  !issue.runBatchId;

export type TriageOptions = {
  issueIds?: string[];
  signal?: AbortSignal;
  includeImages?: boolean;
  onProgress?: (preview: TriagePreview, message: string) => void;
};

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
      projects.add(
        pathKey(snapshot.find((issue) => issue.id === id)!.projectPath),
      );
    }
    if (projects.size !== 1) throw new Error("A group cannot span projects.");
  }
  if (assigned.size !== ids.size)
    throw new Error("Triage omitted backlog issues. Retry triage.");
  const issues = loadLocalIssues();
  for (const issue of issues) {
    if (ids.has(issue.id))
      issue.dependsOn = (issue.dependsOn ?? []).filter(
        (id) => !issue.triageDependencies?.includes(id),
      );
  }
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
export async function triageBacklog(
  project?: string,
  options: TriageOptions = {},
): Promise<TriagePreview> {
  const snapshot = loadLocalIssues().filter(
    (issue) =>
      eligibleForTriage(issue) &&
      (!project || pathKey(issue.projectPath) === pathKey(project)) &&
      (options.issueIds
        ? options.issueIds.includes(issue.id)
        : !issue.triageGroup),
  );
  if (!snapshot.length)
    throw new Error("There are no unassigned backlog issues to triage.");
  if (snapshot.some((issue) => !issue.projectPath || issue.projectPath === "~"))
    throw new Error("Choose a project for every backlog issue before triage.");
  const target = loadTriageModel(project);
  const plan: TriagePlan = { groups: [], dependencies: [] };
  const analyzed: LocalIssue[] = [];
  const warnings: string[] = [];
  for (const cwd of new Set(snapshot.map((issue) => issue.projectPath))) {
    const projectIssues = snapshot.filter((issue) => issue.projectPath === cwd);
    // Bound ticket text per request as well as count; keep successful batches reviewable.
    const batches: LocalIssue[][] = [];
    for (const issue of projectIssues) {
      let batch = batches[batches.length - 1];
      if (
        !batch ||
        batch.length >= 100 ||
        JSON.stringify([...batch, issue]).length > 100_000
      ) {
        batch = [];
        batches.push(batch);
      }
      batch.push(issue);
    }
    if (batches.length > 1)
      warnings.push(
        `${cwd}: analyzed in ${batches.length} batches. Review groups across batches for possible merges.`,
      );
    for (const [index, batch] of batches.entries()) {
      if (options.signal?.aborted) break;
      try {
        options.onProgress?.(
          {
            plan: structuredClone(plan),
            snapshot: [...analyzed],
            warnings: [...warnings],
          },
          `Inspecting ${cwd} · batch ${index + 1}/${batches.length}`,
        );
        const images: Attachment[] = [];
        for (const issue of batch) {
          if (!issue.images?.length) continue;
          if (!options.includeImages) {
            warnings.push(
              `MC-${issue.number}: screenshots were not analyzed. Enable screenshots with a vision-capable model to include them.`,
            );
            continue;
          }
          const available = issue.images
            .filter((image) => image.size <= 2_000_000)
            .slice(0, Math.max(0, 8 - images.length));
          if (available.length !== issue.images.length)
            warnings.push(
              `MC-${issue.number}: some screenshots exceeded the 8-image / 2 MB-per-image limit and were not analyzed.`,
            );
          for (const image of await loadIssueImages(available))
            images.push({
              ...image,
              name: `MC-${issue.number}: ${image.name}`,
            });
        }
        if (options.signal?.aborted) break;
        const context = loadLocalIssues()
          .filter(
            (issue) =>
              pathKey(issue.projectPath) === pathKey(cwd) && !issue.archived,
          )
          .sort(
            (a, b) => Number(a.status === "done") - Number(b.status === "done"),
          )
          .map(({ id, number, title, status, dependsOn }) => ({
            id,
            number,
            title: title.slice(0, 300),
            status,
            dependsOn,
          }));
        const fullContextCount = context.length;
        while (JSON.stringify(context).length > 80_000) context.pop();
        if (context.length < fullContextCount)
          warnings.push(
            `${cwd}: existing-issue context was limited to ${context.length}/${fullContextCount} tickets. Review dependencies against omitted tickets.`,
          );
        const result = await runTriageAgent({
          cwd,
          issues: batch,
          context,
          images,
          target,
          signal: options.signal,
        });
        if (options.signal?.aborted) break;
        // Validate the combined plan too: batches can introduce group-level deadlocks.
        const combined = {
          groups: [...plan.groups, ...result.groups],
          dependencies: [...plan.dependencies, ...result.dependencies],
        };
        validateTriagePlan(combined, [...analyzed, ...batch]);
        plan.groups = combined.groups;
        plan.dependencies = combined.dependencies;
        analyzed.push(...batch);
        options.onProgress?.(
          {
            plan: structuredClone(plan),
            snapshot: [...analyzed],
            warnings: [...warnings],
          },
          `Analyzed ${analyzed.length}/${snapshot.length} issues`,
        );
      } catch (error) {
        if (!options.signal?.aborted)
          warnings.push(
            `${cwd}, batch ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
      }
    }
    if (options.signal?.aborted) break;
  }
  if (options.signal?.aborted)
    warnings.push(
      "Analysis cancelled. Completed batches are available below; unfinished tickets are unchanged.",
    );
  if (!analyzed.length)
    throw new Error(warnings.join("\n") || "No issues were analyzed.");
  return { plan, snapshot: analyzed, warnings };
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
              ...(issue.dependsOn ?? []).filter(
                (id) => !issue.triageDependencies?.includes(id),
              ),
              ...dependencies.map((entry) => entry.dependsOn),
            ]),
          ],
          triageDependencies: dependencies
            .map((entry) => entry.dependsOn)
            .filter(
              (id) =>
                !issue.dependsOn?.includes(id) ||
                issue.triageDependencies?.includes(id),
            ),
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
  return withIssueDispatchLock(() => dispatchIssueGroup(groupId, launch));
}

async function dispatchIssueGroup(
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
  if (new Set(issues.map((issue) => pathKey(issue.projectPath))).size !== 1)
    throw new Error(
      "An assignment cannot span projects. Detach tickets moved to another project.",
    );
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
  const readiness = issueGroupReadiness(issues, all);
  if (readiness) throw new Error(readiness);
  const settings = issues.filter(
    (issue) => issue.modelSettings && Object.keys(issue.modelSettings).length,
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
  await startReservedLocalIssue(reserved[0]!.id, launch);
}

/** Used both by the group card and dispatch so disabled controls explain the real blocker. */
export function issueGroupReadiness(
  issues: LocalIssue[],
  all = loadLocalIssues(),
): string | undefined {
  const first = issues[0];
  if (!first) return "No unfinished issues.";
  if (new Set(issues.map((issue) => pathKey(issue.projectPath))).size !== 1)
    return "An assignment cannot span projects.";
  if (issues.some(isIssueRunning)) return "Agent working";
  const occupied = repositoryAssignmentBlocker(first, all);
  if (occupied)
    return `Waiting for MC-${occupied.number} to finish and commit its assignment.`;
  const blockers = issues.flatMap((issue) =>
    issueBlockers(
      issue,
      all,
      issues.map((member) => member.id),
    ),
  );
  if (blockers.length)
    return `Blocked by ${[...new Set(blockers.map((issue) => `MC-${issue.number}`))].join(", ")}.`;
  for (const key of ["agent", "model"] as const) {
    if (new Set(issues.map((issue) => issue[key]).filter(Boolean)).size > 1)
      return "Choose the same agent and model for the grouped issues before starting.";
  }
  if (
    new Set(
      issues
        .filter(
          (issue) =>
            issue.modelSettings && Object.keys(issue.modelSettings).length,
        )
        .map((issue) =>
          JSON.stringify(Object.entries(issue.modelSettings!).sort()),
        ),
    ).size > 1
  )
    return "Choose the same model options for the grouped issues before starting.";
}

export function detachUnstartedIssue(id: string) {
  const issue = loadLocalIssues().find((entry) => entry.id === id);
  if (!issue || issue.sessionId || issue.runBatchId || isIssueRunning(issue))
    throw new Error(
      "Only an unstarted ticket can be detached. Existing work keeps its shared review and commit.",
    );
  updateLocalIssues([
    {
      id,
      patch: { triageGroup: undefined },
      message: "Detached from assignment group",
    },
  ]);
}
