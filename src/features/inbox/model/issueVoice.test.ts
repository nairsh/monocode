// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  createLocalIssue,
  loadLocalIssues,
  updateLocalIssue,
} from "./localIssues";
import {
  applyIssueVoicePlan,
  explicitIssueVoiceCommand,
  validateIssueVoicePlan,
} from "./issueVoice";

beforeEach(() => localStorage.clear());
const seed = (projectPath = "/repo") =>
  createLocalIssue({
    projectPath,
    title: "Fix login",
    description: "",
    status: "backlog",
    priority: 0,
    labels: [],
    agent: "",
  });
it("creates and updates issues through the board's store without starting work implicitly", async () => {
  const plan = validateIssueVoicePlan(
    explicitIssueVoiceCommand("Create an issue called Fix login"),
    "/repo",
    [],
  );
  const launch = vi.fn();
  await applyIssueVoicePlan(plan, launch);
  const issue = loadLocalIssues()[0];
  expect(issue).toMatchObject({
    title: "Fix login",
    status: "backlog",
    projectPath: "/repo",
  });
  await applyIssueVoicePlan(plan, launch);
  expect(loadLocalIssues()).toHaveLength(1);
  const update = validateIssueVoicePlan(
    explicitIssueVoiceCommand(`Set MC-${issue.number} priority to high`),
    "/repo",
    loadLocalIssues(),
  );
  await applyIssueVoicePlan(update, launch);
  expect(loadLocalIssues()[0].priority).toBe(2);
  expect(launch).not.toHaveBeenCalled();
});
it("uses the existing launch path without claiming a provider is running before its event", async () => {
  const issue = seed();
  const launch = vi.fn(async () => {});
  const plan = validateIssueVoicePlan(
    explicitIssueVoiceCommand(`Start an agent on MC-${issue.number}`),
    "/repo",
    loadLocalIssues(),
  );
  await applyIssueVoicePlan(plan, launch);
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({ id: issue.id, runState: "starting" }),
  );
  expect(loadLocalIssues()[0]).toMatchObject({
    runState: "starting",
    status: "todo",
  });
});
it("rejects cross-project issue IDs and executable/unknown fields", () => {
  const other = seed("/other");
  expect(() =>
    validateIssueVoicePlan(
      { actions: [{ action: "issues.start", input: { issueId: other.id } }] },
      "/repo",
      loadLocalIssues(),
    ),
  ).toThrow("selected project");
  expect(() =>
    validateIssueVoicePlan(
      {
        actions: [
          {
            action: "issues.create",
            input: { title: "Oops", shell: "anything" },
          },
        ],
      },
      "/repo",
      [],
    ),
  ).toThrow("unsupported");
  expect(() =>
    validateIssueVoicePlan(
      {
        actions: [{ action: "sessions.start", input: { prompt: "anything" } }],
      },
      "/repo",
      [],
    ),
  ).toThrow("unsupported");
});
it("refuses a stale preview before applying any of its actions", async () => {
  const issue = seed();
  const plan = validateIssueVoicePlan(
    {
      actions: [
        { action: "issues.create", input: { title: "New" } },
        { action: "issues.update", input: { issueId: issue.id, priority: 1 } },
      ],
    },
    "/repo",
    loadLocalIssues(),
  );
  updateLocalIssue(issue.id, { title: "Changed elsewhere" });
  await expect(applyIssueVoicePlan(plan)).rejects.toThrow(
    "changed after preview",
  );
  expect(loadLocalIssues()).toHaveLength(1);
});
it("checks dispatch availability before creating an issue with Start agent", async () => {
  const plan = validateIssueVoicePlan(
    {
      actions: [
        { action: "issues.create", input: { title: "New" }, startAgent: true },
      ],
    },
    "/repo",
    [],
  );
  await expect(applyIssueVoicePlan(plan)).rejects.toThrow("dispatch");
  expect(loadLocalIssues()).toEqual([]);
});
it("never manufactures an in-progress state from a property update", () => {
  const issue = seed();
  expect(() =>
    validateIssueVoicePlan(
      explicitIssueVoiceCommand(`Move MC-${issue.number} to in_progress`),
      "/repo",
      loadLocalIssues(),
    ),
  ).toThrow("Start agent");
});
it("preserves progress receipts when a later dispatch fails", async () => {
  const issue = seed();
  const plan = validateIssueVoicePlan(
    {
      actions: [
        { action: "issues.create", input: { title: "New" } },
        { action: "issues.start", input: { issueId: issue.id } },
      ],
    },
    "/repo",
    loadLocalIssues(),
  );
  const applied = vi.fn();
  await expect(
    applyIssueVoicePlan(
      plan,
      async () => {
        throw new Error("Provider offline");
      },
      applied,
    ),
  ).rejects.toThrow("Provider offline");
  expect(applied).toHaveBeenCalledTimes(1);
  expect(loadLocalIssues().find((row) => row.id === issue.id)?.runState).toBe(
    "failed",
  );
});
