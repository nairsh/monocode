// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  sendHarnessTurn,
  forgetHarnessSession,
} from "../../../integrations/harness/core/registry";
import { createLocalIssue, loadLocalIssues } from "./localIssues";
import { planIssueVoiceCommand } from "./issueVoiceAgent";

vi.mock("../../../integrations/harness/core/registry", () => ({
  sendHarnessTurn: vi.fn(),
  forgetHarnessSession: vi.fn(async () => {}),
  cancelHarnessTurn: vi.fn(),
  respondHarnessApproval: vi.fn(),
  respondHarnessQuestion: vi.fn(),
}));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
it("sends only the selected project's issues to the configured provider and validates its tools", async () => {
  const issue = createLocalIssue({
    title: "Login",
    projectPath: "/repo",
    description: "",
    status: "backlog",
    priority: 0,
    labels: [],
    agent: "",
  });
  createLocalIssue({
    title: "Private other project",
    projectPath: "/other",
    description: "",
    status: "backlog",
    priority: 0,
    labels: [],
    agent: "",
  });
  vi.mocked(sendHarnessTurn).mockImplementation(async (request) => {
    expect(request.appAccess).toBe(false);
    expect(request.text).toContain("Login");
    expect(request.text).not.toContain("Private other project");
    request.onEvent({
      type: "message.delta",
      text: JSON.stringify({
        actions: [
          {
            action: "issues.update",
            input: { issueId: issue.id, priority: 1 },
          },
        ],
      }),
    });
  });
  const plan = await planIssueVoiceCommand(
    "Make the login ticket urgent please",
    "/repo",
    loadLocalIssues(),
    new AbortController().signal,
  );
  expect(plan.actions[0].input).toMatchObject({
    issueId: issue.id,
    priority: 1,
  });
  expect(forgetHarnessSession).toHaveBeenCalledTimes(1);
  expect(loadLocalIssues().find((row) => row.id === issue.id)?.priority).toBe(
    0,
  );
});
it("supports explicit issue creation without a provider and respects cancellation", async () => {
  await planIssueVoiceCommand(
    "Create an issue called Improve search",
    "/repo",
    [],
    new AbortController().signal,
  );
  expect(sendHarnessTurn).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(
    planIssueVoiceCommand(
      "Create an issue called No",
      "/repo",
      [],
      controller.signal,
    ),
  ).rejects.toThrow();
});
