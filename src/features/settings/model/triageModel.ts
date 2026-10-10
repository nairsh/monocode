import { HARNESSES, type ModelTarget } from "../../sessions/model/session";
import {
  defaultSessionChoice,
  preferredModelSettings,
  resolveModel,
} from "../../sessions/model/models";

const KEY = "monocode.triageModel.v1";

export function loadTriageModel(project?: string): ModelTarget {
  try {
    const saved = JSON.parse(
      localStorage.getItem(KEY) ?? "null",
    ) as ModelTarget | null;
    if (
      saved &&
      HARNESSES.includes(saved.harness) &&
      typeof saved.model === "string" &&
      saved.model.trim() &&
      saved.modelSettings &&
      typeof saved.modelSettings === "object" &&
      !Array.isArray(saved.modelSettings) &&
      Object.values(saved.modelSettings).every(
        (value) => typeof value === "string",
      )
    )
      return saved;
  } catch {
    /* Use the normal conversation default for new or invalid settings. */
  }
  const choice = defaultSessionChoice(project);
  return {
    ...choice,
    modelSettings: preferredModelSettings(
      resolveModel(choice.harness, choice.model),
    ),
  };
}

export function saveTriageModel(target: ModelTarget) {
  localStorage.setItem(KEY, JSON.stringify(target));
}
