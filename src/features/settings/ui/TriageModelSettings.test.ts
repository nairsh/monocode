// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TaskModelSettings } from "./TaskModelSettings";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("retains and saves a separate triage model and reasoning effort using the task endpoint", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(invoke).mockImplementation(async (command, args) =>
    command === "task_model_config"
      ? {
          endpoint: "http://localhost:8000/v1",
          model: "task",
          reasoningEffort: "low",
          hasApiKey: true,
          triageModel: "triage",
          triageReasoningEffort: "high",
        }
      : { ...(args as { config: object }).config, hasApiKey: true },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TaskModelSettings)));
    expect(
      container.querySelector<HTMLSelectElement>('[aria-label="Triage model"]')!
        .value,
    ).toBe("triage");
    expect(
      container.querySelector<HTMLSelectElement>(
        '[aria-label="Triage reasoning effort"]',
      )!.value,
    ).toBe("high");
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(invoke).toHaveBeenCalledWith("task_model_save", {
      config: {
        endpoint: "http://localhost:8000/v1",
        apiKey: "",
        model: "task",
        reasoningEffort: "low",
        triageModel: "triage",
        triageReasoningEffort: "high",
      },
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
