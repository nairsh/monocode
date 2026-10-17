import { pathKey, projectName } from "../../../shared/lib/paths";
import { createMono, findMono, saveMonoName } from "../../monos/model/mono";
import { HARNESSES, type ModelTarget } from "../../sessions/model/session";

export type ProjectCoordinatorPreferences = {
  project: string;
  goal: string;
  instructions: string;
  threadDefaults?: ModelTarget;
  workspaceMode: "current" | "worktree";
  autoContinue: boolean;
  paused: boolean;
  archived: boolean;
};
const KEY = "monocode.projectCoordinators.v1";
const CHANGED = "monocode:project-coordinator-change";
const OPEN = "monocode:open-project-coordinator";
export function projectThreadPromptText(prompt: string) {
  const marker = prompt.lastIndexOf("\n\n<project_context>\n");
  return marker >= 0 && prompt.endsWith("\n</project_context>")
    ? prompt.slice(0, marker)
    : prompt;
}
function read(): Record<string, ProjectCoordinatorPreferences> {
  const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
export function projectCoordinatorPreferences(
  id: string,
): ProjectCoordinatorPreferences | undefined {
  try {
    const value = read()[id];
    if (!value || typeof value.project !== "string" || !value.project) return;
    const target = value.threadDefaults;
    return {
      project: value.project,
      goal: typeof value.goal === "string" ? value.goal : "",
      instructions:
        typeof value.instructions === "string" ? value.instructions : "",
      ...(target &&
      HARNESSES.includes(target.harness) &&
      typeof target.model === "string" &&
      target.modelSettings &&
      typeof target.modelSettings === "object" &&
      !Array.isArray(target.modelSettings) &&
      Object.values(target.modelSettings).every(
        (setting) => typeof setting === "string",
      )
        ? { threadDefaults: target }
        : {}),
      workspaceMode:
        value.workspaceMode === "worktree" ? "worktree" : "current",
      autoContinue: value.autoContinue === true,
      paused: value.paused === true,
      archived: value.archived === true,
    };
  } catch {
    return;
  }
}
export function updateProjectCoordinator(
  id: string,
  patch: Partial<Omit<ProjectCoordinatorPreferences, "project">>,
) {
  const current = projectCoordinatorPreferences(id);
  if (!current) throw new Error("Project coordinator was not found.");
  const all = read();
  all[id] = { ...current, ...patch };
  localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new Event(CHANGED));
}
/** One durable conversation per project. Never replace an existing coordinator. */
export function ensureProjectCoordinator(project: string): string {
  if (!project || project === "~")
    throw new Error("Choose a project folder first.");
  const all = read();
  const existing = Object.keys(all).find(
    (id) =>
      pathKey(all[id]?.project ?? "") === pathKey(project) && findMono(id),
  );
  if (existing) {
    if (projectCoordinatorPreferences(existing)?.archived)
      updateProjectCoordinator(existing, { archived: false });
    return existing;
  }
  const mono = createMono([project]);
  saveMonoName(mono.id, projectName(project));
  all[mono.id] = {
    project,
    goal: "",
    instructions: "",
    workspaceMode: "current",
    autoContinue: false,
    paused: false,
    archived: false,
  };
  localStorage.setItem(KEY, JSON.stringify(all));
  window.dispatchEvent(new Event(CHANGED));
  return mono.id;
}
export function projectCoordinatorSnapshot() {
  return localStorage.getItem(KEY) ?? "";
}
export function subscribeProjectCoordinators(listener: () => void) {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
export function requestProjectCoordinator(project: string) {
  window.dispatchEvent(new CustomEvent(OPEN, { detail: project }));
}
export function subscribeOpenProjectCoordinator(
  listener: (project: string) => void,
) {
  const open = (event: Event) => {
    const project = (event as CustomEvent).detail;
    if (typeof project === "string") listener(project);
  };
  window.addEventListener(OPEN, open);
  return () => window.removeEventListener(OPEN, open);
}
