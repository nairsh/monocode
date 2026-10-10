// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  cancelHarnessTurn,
  forgetHarnessSession,
  respondHarnessApproval,
  respondHarnessQuestion,
  sendHarnessTurn,
} from "../../../integrations/harness/core/registry";
import { createLocalIssue } from "./localIssues";
import {
  parseTriageAgentPlan,
  runTriageAgent,
  type TriageAgentInput,
} from "./triageAgent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../integrations/harness/core/registry", () => ({
  sendHarnessTurn: vi.fn(),
  cancelHarnessTurn: vi.fn(async () => {}),
  forgetHarnessSession: vi.fn(async () => {}),
  respondHarnessApproval: vi.fn(),
  respondHarnessQuestion: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "issue_triage_open"
      ? { id: "run", path: "/isolated" }
      : undefined,
  );
});
const input = (): TriageAgentInput => ({
  cwd: "/repo",
  target: {
    harness: "claude",
    model: "claude:sonnet-4.6",
    modelSettings: { effort: "high" },
  },
  issues: [
    createLocalIssue({
      title: "Streaming",
      description: "Fix ordering",
      projectPath: "/repo",
      status: "backlog",
      agent: "",
      labels: [],
      priority: 2,
    }),
  ],
  context: [],
  images: [
    {
      id: "image",
      name: "MC-1: screenshot",
      mimeType: "image/png",
      data: "abc",
      kind: "image",
      size: 3,
    },
  ],
});
const plan = {
  groups: [
    {
      title: "Streaming",
      reason: "Shared code",
      files: ["src/stream.ts"],
      issueIds: ["ticket"],
    },
  ],
  dependencies: [],
};

it("runs the selected normal model with images in an isolated plan session and cleans it up", async () => {
  const request = input();
  vi.mocked(sendHarnessTurn).mockImplementation(async (turn) => {
    turn.onEvent({ type: "message.delta", text: "Inspecting the source." });
    turn.onEvent({ type: "message.completed" });
    turn.onEvent({ type: "approval.requested", requestId: 1, title: "Write" });
    turn.onEvent({ type: "question.asked", requestId: 2, questions: [] });
    turn.onEvent({
      type: "message.delta",
      text: "```triage-plan\n" + JSON.stringify(plan) + "\n```",
    });
    turn.onEvent({ type: "message.completed" });
  });
  await expect(runTriageAgent(request)).resolves.toEqual(plan);
  expect(sendHarnessTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      harness: "claude",
      model: "claude:sonnet-4.6",
      modelSettings: { effort: "high" },
      cwd: "/isolated",
      sessionId: "triage-run",
      runtimeMode: "supervised",
      intent: "plan",
      appAccess: false,
      ephemeral: true,
      attachments: request.images,
    }),
  );
  expect(respondHarnessApproval).toHaveBeenCalledWith(
    "claude",
    "triage-run",
    1,
    "deny",
  );
  expect(respondHarnessQuestion).toHaveBeenCalledWith(
    "claude",
    "triage-run",
    2,
    { kind: "skipped" },
  );
  expect(invoke).toHaveBeenCalledWith("issue_triage_validate", {
    id: "run",
    plan,
  });
  expect(forgetHarnessSession).toHaveBeenCalledWith("claude", "triage-run");
  expect(invoke).toHaveBeenLastCalledWith("issue_triage_close", { id: "run" });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([name]) => name.startsWith("task_model")),
  ).toBe(false);
});

it("cancels only its own session, including cancellation during provider startup", async () => {
  const controller = new AbortController();
  vi.mocked(sendHarnessTurn).mockImplementation(async (turn) => {
    controller.abort();
    turn.onEvent({ type: "session.started" });
    turn.onEvent({ type: "message.delta", text: JSON.stringify(plan) });
  });
  await expect(
    runTriageAgent({ ...input(), signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  expect(cancelHarnessTurn).toHaveBeenCalledTimes(2);
  expect(cancelHarnessTurn).toHaveBeenCalledWith("claude", "triage-run");
  expect(invoke).not.toHaveBeenCalledWith(
    "issue_triage_validate",
    expect.anything(),
  );
  expect(invoke).toHaveBeenLastCalledWith("issue_triage_close", { id: "run" });
});

it("cleans up after malformed output, provider errors, and invalid source citations", async () => {
  vi.mocked(sendHarnessTurn).mockImplementation(async (turn) => {
    turn.onEvent({ type: "message.delta", text: "not a plan" });
  });
  await expect(runTriageAgent(input())).rejects.toThrow("valid plan");
  vi.mocked(sendHarnessTurn).mockImplementation(async (turn) => {
    turn.onEvent({ type: "session.error", message: "Provider unavailable" });
  });
  await expect(runTriageAgent(input())).rejects.toThrow("Provider unavailable");
  vi.mocked(sendHarnessTurn).mockImplementation(async (turn) => {
    turn.onEvent({ type: "message.delta", text: JSON.stringify(plan) });
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "issue_triage_open")
      return { id: "run", path: "/isolated" };
    if (command === "issue_triage_validate")
      throw new Error("Invalid source citation");
  });
  await expect(runTriageAgent(input())).rejects.toThrow(
    "Invalid source citation",
  );
  expect(forgetHarnessSession).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenLastCalledWith("issue_triage_close", { id: "run" });
});

it("does not create a workspace for an already cancelled request and rejects non-plan JSON", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runTriageAgent({ ...input(), signal: controller.signal }),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  expect(() => parseTriageAgentPlan("null")).toThrow("valid plan");
});
