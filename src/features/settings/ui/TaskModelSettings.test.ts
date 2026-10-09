// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TaskModelSettings } from "./TaskModelSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "task_model_config") return null;
    if (command === "task_model_models") return ["model-a", "model-b"];
    if (command === "task_model_save")
      return { ...(args as { config: object }).config, hasApiKey: true };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function change(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLInputElement ? "input" : "change", {
        bubbles: true,
      }),
    );
  });
}
async function click(text: string) {
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === text)!
      .click(),
  );
}
it("loads endpoint models and saves the chosen model and reasoning effort", async () => {
  await act(async () => root.render(createElement(TaskModelSettings)));
  await change("Task model endpoint", "http://localhost:8000/v1");
  await change("Task model API key", "test-key");
  await click("Load models");
  expect(invoke).toHaveBeenCalledWith("task_model_models", {
    endpoint: "http://localhost:8000/v1",
    apiKey: "test-key",
  });
  await change("Task model", "model-b");
  await change("Task model reasoning effort", "high");
  await click("Save task model");
  expect(invoke).toHaveBeenCalledWith("task_model_save", {
    config: {
      endpoint: "http://localhost:8000/v1",
      apiKey: "test-key",
      model: "model-b",
      reasoningEffort: "high",
    },
  });
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Task model API key"]',
    )!.value,
  ).toBe("");
  expect(container.textContent).toContain("Task model saved.");
  await change("Task model endpoint", "http://other-endpoint/v1");
  expect(
    container.querySelector<HTMLSelectElement>('[aria-label="Task model"]')!
      .value,
  ).toBe("");
});
it("keeps existing selections without exposing the saved key", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    endpoint: "http://localhost:8000/v1",
    model: "saved-model",
    reasoningEffort: "low",
    hasApiKey: true,
  });
  await act(async () => root.render(createElement(TaskModelSettings)));
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Task model API key"]',
    )!.placeholder,
  ).toContain("Saved key");
  await click("Save task model");
  expect(invoke).toHaveBeenLastCalledWith("task_model_save", {
    config: {
      endpoint: "http://localhost:8000/v1",
      apiKey: "",
      model: "saved-model",
      reasoningEffort: "low",
    },
  });
});
it("shows discovery failures without losing the endpoint", async () => {
  await act(async () => root.render(createElement(TaskModelSettings)));
  await change("Task model endpoint", "http://localhost:8000");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("HTTP 401"));
  await click("Load models");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "HTTP 401",
  );
  expect(
    container.querySelector<HTMLInputElement>(
      '[aria-label="Task model endpoint"]',
    )!.value,
  ).toBe("http://localhost:8000");
});
