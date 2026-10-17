// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { listMonos, removeMono } from "../../monos/model/mono";
import {
  ensureProjectCoordinator,
  projectCoordinatorPreferences,
  updateProjectCoordinator,
} from "./projectCoordinator";

beforeEach(() => localStorage.clear());
it("keeps one durable coordinator per normalized repository", () => {
  const id = ensureProjectCoordinator("/repo");
  expect(ensureProjectCoordinator("/repo/")).toBe(id);
  expect(listMonos()).toHaveLength(1);
  expect(listMonos()[0].projects).toEqual(["/repo"]);
  updateProjectCoordinator(id, {
    goal: "Ship safely",
    instructions: "Run the tests",
    threadDefaults: {
      harness: "codex",
      model: "gpt-6",
      modelSettings: { effort: "high" },
    },
    workspaceMode: "worktree",
  });
  expect(projectCoordinatorPreferences(id)).toMatchObject({
    goal: "Ship safely",
    instructions: "Run the tests",
    workspaceMode: "worktree",
    threadDefaults: { modelSettings: { effort: "high" } },
  });
  expect(ensureProjectCoordinator("/repo")).toBe(id);
});
it("restores an archived project and replaces a deleted coordinator only", () => {
  const id = ensureProjectCoordinator("/repo");
  updateProjectCoordinator(id, { archived: true, paused: true });
  expect(ensureProjectCoordinator("/repo")).toBe(id);
  expect(projectCoordinatorPreferences(id)).toMatchObject({
    archived: false,
    paused: true,
  });
  removeMono(id);
  expect(ensureProjectCoordinator("/repo")).not.toBe(id);
});
it("does not bind ordinary Monos to a repository", () => {
  expect(projectCoordinatorPreferences("unknown")).toBeUndefined();
  expect(() => ensureProjectCoordinator("~")).toThrow("project folder");
});
