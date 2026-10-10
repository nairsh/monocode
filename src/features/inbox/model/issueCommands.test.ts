// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import {
  handleAgentApp,
  type AgentAppHost,
} from "../../agent-app/model/agentApp";
import { newSession } from "../../sessions/model/session";
import {
  createLocalIssue,
  loadLocalIssues,
  updateLocalIssue,
} from "./localIssues";

beforeEach(() => localStorage.clear());
const source = newSession("codex", "/repo");
const host = {} as AgentAppHost;
const run = (
  action: string,
  input: Record<string, unknown> = {},
  request: string = crypto.randomUUID(),
) => handleAgentApp(source, request, action, input, host);
const seed = (projectPath = "/repo") =>
  createLocalIssue({
    title: "Ticket",
    description: "Details",
    projectPath,
    status: "backlog",
    priority: 0,
    labels: [],
    agent: "",
  });

it("lists, reads, edits and comments through the existing app CLI handler", async () => {
  const issue = seed();
  expect(await run("issues.list")).toMatchObject({
    issues: [{ identifier: `MC-${issue.number}` }],
  });
  await run("issues.update", {
    issueId: `MC-${issue.number}`,
    status: "todo",
    priority: 2,
    description: "More detail",
    labels: ["auth"],
  });
  await run("issues.comment", {
    issueId: issue.id,
    text: "Investigated the auth path",
  });
  expect(await run("issues.get", { issueId: issue.id })).toMatchObject({
    status: "todo",
    priority: 2,
    description: "More detail",
    labels: ["auth"],
  });
  expect(loadLocalIssues()[0]!.activity.at(-1)!.text).toContain("Investigated");
  expect(loadLocalIssues()[0]!.runState).toBeUndefined();
});

it("does not let an agent complete or manufacture a running assignment through status edits", async () => {
  const issue = seed();
  await expect(
    run("issues.update", { issueId: issue.id, status: "in_progress" }),
  ).rejects.toThrow("when an agent starts");
  updateLocalIssue(issue.id, {
    sessionId: source.id,
    runState: "running",
    status: "in_progress",
  });
  await expect(
    run("issues.update", { issueId: issue.id, status: "done" }),
  ).rejects.toThrow("human review");
  await run("issues.update", { issueId: issue.id, priority: 1 });
  expect(loadLocalIssues()[0]).toMatchObject({
    status: "in_progress",
    priority: 1,
  });
  updateLocalIssue(issue.id, { runState: "completed", status: "in_review" });
  await expect(
    run("issues.update", { issueId: issue.id, status: "done" }),
  ).rejects.toThrow("human review");
});

it("creates a ticket once when a request is retried", async () => {
  const first = await run(
    "issues.create",
    { title: "Stream reconnect", priority: 3 },
    "create-once",
  );
  expect(
    await run(
      "issues.create",
      { title: "Stream reconnect", priority: 3 },
      "create-once",
    ),
  ).toEqual(first);
  expect(loadLocalIssues()).toHaveLength(1);
});

it("enforces project scope, allowed fields and valid priorities and statuses", async () => {
  const own = seed();
  const outside = seed("/other");
  await expect(run("issues.get", { issueId: outside.id })).rejects.toThrow(
    "not found",
  );
  await expect(
    run("issues.update", { issueId: own.id, sessionId: "hijack" }),
  ).rejects.toThrow("Unknown");
  await expect(
    run("issues.update", { issueId: own.id, priority: 5 }),
  ).rejects.toThrow("integer");
  await expect(
    run("issues.update", { issueId: own.id, status: "anything" }),
  ).rejects.toThrow("status");
  expect(await run("issues.list")).toMatchObject({ issues: [{ id: own.id }] });
});

it("adds dependencies by MC identifier and rejects cycles and cross-project references", async () => {
  const a = seed();
  const b = seed();
  const other = seed("/other");
  await run("issues.update", { issueId: b.id, dependsOn: [`MC-${a.number}`] });
  expect(loadLocalIssues()[1]!.dependsOn).toEqual([a.id]);
  await expect(
    run("issues.update", { issueId: a.id, dependsOn: [b.id] }),
  ).rejects.toThrow("cycle");
  await expect(
    run("issues.update", { issueId: a.id, dependsOn: [other.id] }),
  ).rejects.toThrow("not found");
  await run("issues.update", { issueId: b.id, dependsOn: [] });
  expect(loadLocalIssues()[1]!.dependsOn).toEqual([]);
});

it("lets agents edit their own running ticket and prevents interference with another agent", async () => {
  const a = seed();
  const b = seed();
  updateLocalIssue(a.id, {
    sessionId: source.id,
    runState: "running",
    status: "in_progress",
  });
  updateLocalIssue(b.id, {
    sessionId: "another",
    runState: "running",
    status: "in_progress",
  });
  await run("issues.update", { issueId: a.id, priority: 1 });
  await expect(
    run("issues.update", { issueId: b.id, priority: 1 }),
  ).rejects.toThrow("Another agent");
  await expect(
    run("issues.update", { issueId: a.id, archived: true }),
  ).rejects.toThrow("Stop");
});
