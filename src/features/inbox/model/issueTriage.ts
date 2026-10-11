import { pathKey } from "../../../shared/lib/paths";
import { loadIssueImages } from "./localIssueImages";
import { runTriageAgent } from "./triageAgent";
import { loadTriageModel } from "../../settings/model/triageModel";
import type { Attachment } from "../../sessions/model/session";
import {
  isIssueRunning,
  issueBlockers,
  loadLocalIssues,
  startReservedLocalIssue,
  withIssueDispatchLock,
  updateLocalIssues,
  validateIssueDependencies,
  type LocalIssue,
} from "./localIssues";

export type TriagePlan = {
  updates?: {
    issueId: string;
    title?: string;
    description?: string;
    priority?: number;
    reason: string;
  }[];
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
export const eligibleForGroupStart = (issue: LocalIssue) =>
  !issue.archived &&
  (issue.status === "backlog" || issue.status === "todo") &&
  !isIssueRunning(issue) &&
  !issue.sessionId &&
  !issue.runBatchId;

export const eligibleForTriage = (issue: LocalIssue) =>
  issue.status === "backlog" && eligibleForGroupStart(issue);

export type TriageOptions = {
  issueIds?: string[];
  signal?: AbortSignal;
  includeImages?: boolean;
  onProgress?: (preview: TriagePreview, message: string) => void;
  onBatch?: (preview: TriagePreview) => void;
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
  const updated = new Set<string>();
  if (plan.updates !== undefined && !Array.isArray(plan.updates))
    throw new Error("Triage returned invalid issue updates.");
  for (const update of plan.updates ?? []) {
    if (
      !update ||
      !ids.has(update.issueId) ||
      updated.has(update.issueId) ||
      typeof update.reason !== "string" ||
      !update.reason.trim() ||
      (update.title !== undefined &&
        (typeof update.title !== "string" ||
          !update.title.trim() ||
          update.title.length > 500)) ||
      (update.description !== undefined &&
        (typeof update.description !== "string" ||
          update.description.length > 50_000)) ||
      (update.priority !== undefined &&
        (!Number.isInteger(update.priority) ||
          update.priority < 0 ||
          update.priority > 4))
    )
      throw new Error("Triage returned an invalid issue update.");
    updated.add(update.issueId);
  }
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
          onProgress: (message) =>
            options.onProgress?.(
              {
                plan: structuredClone(plan),
                snapshot: [...analyzed],
                warnings: [...warnings],
              },
              message,
            ),
        });
        if (options.signal?.aborted) break;
        // Validate the combined plan too: batches can introduce group-level deadlocks.
        const combined = {
          groups: [...plan.groups, ...result.groups],
          dependencies: [...plan.dependencies, ...result.dependencies],
          updates: [...(plan.updates ?? []), ...(result.updates ?? [])],
        };
        validateTriagePlan(combined, [...analyzed, ...batch]);
        options.onBatch?.({
          plan: result,
          snapshot: batch,
          warnings: [...warnings],
        });
        plan.groups = combined.groups;
        plan.dependencies = combined.dependencies;
        plan.updates = combined.updates;
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
      const update = plan.updates?.find((entry) => entry.issueId === id);
      const dependencies = plan.dependencies.filter(
        (entry) => entry.issueId === id,
      );
      return {
        id,
        patch: {
          ...(update?.title !== undefined ? { title: update.title } : {}),
          ...(update?.description !== undefined
            ? { description: update.description }
            : {}),
          ...(update?.priority !== undefined
            ? { priority: update.priority }
            : {}),
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
        message: `Triaged into ${group.title}: ${group.reason}${update ? ` ${update.reason}` : ""}${dependencies.length ? ` Dependencies: ${dependencies.map((entry) => entry.reason).join("; ")}` : ""}`,
      };
    });
  });
  return { before: snapshot, after: updateLocalIssues(changes) };
}

export type TriageUndo = { before: LocalIssue[]; after: LocalIssue[] };
/** Restore only triage-owned fields which have not subsequently been edited. */
export function undoTriage(receipts: TriageUndo[]) {
  const current = loadLocalIssues();
  const keys = [
    "title",
    "description",
    "priority",
    "triageGroup",
    "dependsOn",
    "triageDependencies",
  ] as const;
  const changes = receipts.flatMap(({ before, after }) =>
    before.flatMap((previous) => {
      const latest = current.find((issue) => issue.id === previous.id);
      const applied = after.find((issue) => issue.id === previous.id);
      if (!latest || !applied || !eligibleForTriage(latest)) return [];
      const patch: Partial<LocalIssue> = {};
      for (const key of keys) {
        if (JSON.stringify(latest[key]) === JSON.stringify(applied[key]))
          Object.assign(patch, { [key]: previous[key] });
      }
      return [
        {
          id: previous.id,
          patch,
          message: "Undid triage changes; later edits were preserved",
        },
      ];
    }),
  );
  if (changes.length) updateLocalIssues(changes);
  return changes.length;
}

export async function startIssueGroup(
  groupId: string,
  launch: (issue: LocalIssue) => Promise<void>,
  queuedOnly = false,
) {
  return withIssueDispatchLock(() =>
    dispatchIssueGroup(groupId, launch, queuedOnly),
  );
}

/** Turn a displayed priority/ungrouped row into one explicitly requested assignment. */
export async function startIssueSelection(
  title: string,
  ids: string[],
  launch: (issue: LocalIssue) => Promise<void>,
) {
  return withIssueDispatchLock(async () => {
    const all = loadLocalIssues();
    const members = ids.map((id) => all.find((issue) => issue.id === id));
    if (
      !members.length ||
      members.some((issue) => !issue || !eligibleForGroupStart(issue))
    )
      throw new Error("Start a group with fresh Backlog or To Do issues only.");
    const ready = issueGroupReadiness(members as LocalIssue[], all);
    if (ready) throw new Error(ready);
    const id = crypto.randomUUID();
    updateLocalIssues(
      members.map((issue) => ({
        id: issue!.id,
        patch: {
          triageGroup: {
            id,
            title,
            reason: "Grouped by the user for one shared thread",
            files: [],
          },
        },
        message: "Grouped for one shared thread",
      })),
    );
    await dispatchIssueGroup(id, launch);
  });
}

async function dispatchIssueGroup(
  groupId: string,
  launch: (issue: LocalIssue) => Promise<void>,
  queuedOnly = false,
) {
  const all = loadLocalIssues();
  const issues = all.filter(
    (issue) =>
      issue.triageGroup?.id === groupId &&
      !issue.archived &&
      issue.status !== "done",
  );
  if (
    queuedOnly &&
    !issues.some((issue) => issue.dispatchQueued && issue.status === "todo")
  )
    return;
  if (!issues.length) throw new Error("This group has no unfinished issues.");
  if (new Set(issues.map((issue) => pathKey(issue.projectPath))).size !== 1)
    throw new Error(
      "An assignment cannot span projects. Detach tickets moved to another project.",
    );
  if (issues.some((issue) => !eligibleForGroupStart(issue)))
    throw new Error(
      "Group dispatch requires fresh Backlog or To Do issues. Resume existing assignments from their tickets.",
    );
  // Recheck the graph, since dependencies may have been edited after triage.
  validateIssueDependencies(all);
  const readiness = issueGroupReadiness(issues, all);
  if (readiness) {
    if (queuedOnly) return;
    throw new Error(readiness);
  }
  const settings = issues.filter(
    (issue) => issue.modelSettings && Object.keys(issue.modelSettings).length,
  );
  const runBatchId = crypto.randomUUID();
  const reserved = updateLocalIssues(
    issues.map((issue) => ({
      id: issue.id,
      patch: {
        runBatchId,
        runInWorktree: true,
        dispatchQueued: undefined,
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
  if (
    issues.some((issue) => issue.sessionId || issue.runBatchId) &&
    !issues.some(isIssueRunning)
  )
    return "Continue the existing assignment from its issue or thread.";
  if (new Set(issues.map((issue) => pathKey(issue.projectPath))).size !== 1)
    return "An assignment cannot span projects.";
  if (issues.some(isIssueRunning)) return "Agent working";
  if (issues.some((issue) => !eligibleForGroupStart(issue)))
    return "Start a group with fresh Backlog or To Do issues only.";
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
