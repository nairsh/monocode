import { useState } from "react";
import { ModelPicker } from "../../sessions/ui/ModelPicker";
import {
  preferredModelSettings,
  resolveModel,
} from "../../sessions/model/models";
import { loadTriageModel, saveTriageModel } from "../model/triageModel";
import type { ModelTarget } from "../../sessions/model/session";

export function TriageModelSettings({ project }: { project?: string }) {
  const [target, setTarget] = useState(() => loadTriageModel(project));
  const [error, setError] = useState("");
  const change = (next: ModelTarget) => {
    try {
      saveTriageModel(next);
      setTarget(next);
      setError("");
    } catch {
      setError("The triage model could not be saved.");
    }
  };
  return (
    <div className="flex flex-col gap-2" aria-label="Triage model settings">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-content/65">Triage model</span>
        <ModelPicker
          harness={target.harness}
          model={target.model}
          values={target.modelSettings}
          project={project}
          hotkeys={false}
          side="bottom"
          onChange={(harness, model) =>
            change({
              harness,
              model,
              modelSettings: preferredModelSettings(
                resolveModel(harness, model),
              ),
            })
          }
          onSettingsChange={(modelSettings) =>
            change({ ...target, modelSettings })
          }
        />
      </div>
      <p className="text-[12px] text-content/45">
        Uses the selected agent’s normal connection and project account. Saved
        automatically, independently of the task model.
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
