// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TriageModelSettings } from "./TriageModelSettings";
import { loadTriageModel, saveTriageModel } from "../model/triageModel";
import { ModelPicker } from "../../sessions/ui/ModelPicker";

vi.mock("../../sessions/ui/ModelPicker", () => ({
  ModelPicker: vi.fn(() => null),
}));

it("uses the normal picker and retains its independent provider, model and options", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  saveTriageModel({
    harness: "claude",
    model: "claude:sonnet-4.6",
    modelSettings: { effort: "high" },
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(TriageModelSettings, { project: "/repo" })),
    );
    const picker = () => vi.mocked(ModelPicker).mock.calls.slice(-1)[0][0];
    expect(picker()).toMatchObject({
      harness: "claude",
      model: "claude:sonnet-4.6",
      values: { effort: "high" },
      project: "/repo",
    });
    await act(async () => picker().onChange("codex", "codex:gpt-5.4"));
    await act(async () =>
      picker().onSettingsChange({ reasoningEffort: "low" }),
    );
    expect(loadTriageModel()).toEqual({
      harness: "codex",
      model: "codex:gpt-5.4",
      modelSettings: { reasoningEffort: "low" },
    });
    expect(container.textContent).toContain("independently of the task model");
  } finally {
    await act(async () => root.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
