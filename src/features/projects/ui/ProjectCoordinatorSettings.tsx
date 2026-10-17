import { useState, useSyncExternalStore } from "react";
import { ModelPicker } from "../../sessions/ui/ModelPicker";
import type { ModelTarget } from "../../sessions/model/session";
import {
  projectCoordinatorPreferences,
  projectCoordinatorSnapshot,
  subscribeProjectCoordinators,
  updateProjectCoordinator,
} from "../model/projectCoordinator";

export function ProjectCoordinatorSettings({
  monoId,
  fallback,
  mode = "general",
  onPause,
  onArchive,
  onDelete,
}: {
  monoId: string;
  fallback: ModelTarget;
  mode?: "general" | "instructions" | "environment";
  onPause?: (paused: boolean) => Promise<void>;
  onArchive?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  useSyncExternalStore(
    subscribeProjectCoordinators,
    projectCoordinatorSnapshot,
  );
  const preferences = projectCoordinatorPreferences(monoId);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!preferences) return null;
  const save = (patch: Parameters<typeof updateProjectCoordinator>[1]) => {
    try {
      updateProjectCoordinator(monoId, patch);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const target = preferences.threadDefaults ?? fallback;
  const field =
    "w-full rounded-lg border border-stroke bg-content/3 p-3 text-[13px] text-content outline-none focus:border-accent";
  return (
    <section
      className="flex flex-col gap-4 py-5 text-[13px]"
      aria-label={`Project ${mode}`}
    >
      {mode === "instructions" ? (
        <>
          <h3 className="font-medium">Instructions for new threads</h3>
          <p className="text-content/50">
            Read by every new project thread, along with the coordinator’s
            current MEMORY.md.
          </p>
          <textarea
            aria-label="Thread instructions"
            className={field}
            key={`${monoId}:instructions`}
            defaultValue={preferences.instructions}
            rows={8}
            maxLength={20000}
            onBlur={(event) => save({ instructions: event.target.value })}
          />
        </>
      ) : mode === "environment" ? (
        <>
          <h3 className="font-medium">Thread environment</h3>
          <p className="break-all text-content/55">
            Primary repository: {preferences.project}
          </p>
          <label className="flex justify-between gap-4">
            New thread checkout
            <select
              aria-label="New thread checkout"
              className="rounded-md bg-content/5 p-2"
              value={preferences.workspaceMode}
              onChange={(event) =>
                save({
                  workspaceMode: event.target.value as "current" | "worktree",
                })
              }
            >
              <option value="current">Current checkout</option>
              <option value="worktree">New worktree</option>
            </select>
          </label>
          <p className="text-content/50">
            Repositories and remote hosts are bound in General → Projects.
            Remote repositories use MonoCode’s connected host; local
            repositories use this device.
          </p>
        </>
      ) : (
        <>
          <label className="flex flex-col gap-2">
            Project goal
            <textarea
              aria-label="Project goal"
              className={field}
              key={`${monoId}:goal`}
              defaultValue={preferences.goal}
              rows={3}
              maxLength={8000}
              onBlur={(event) => save({ goal: event.target.value })}
            />
          </label>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3>Default model for new threads</h3>
              <p className="text-[12px] text-content/45">
                Separate from the coordinator model below.
              </p>
            </div>
            <ModelPicker
              harness={target.harness}
              model={target.model}
              values={target.modelSettings}
              project={preferences.project}
              variant="plain"
              onChange={(harness, model) =>
                save({ threadDefaults: { harness, model, modelSettings: {} } })
              }
              onSettingsChange={(modelSettings) =>
                save({ threadDefaults: { ...target, modelSettings } })
              }
            />
          </div>
          <label className="flex items-center justify-between gap-4">
            Auto-continue after usage resets
            <input
              aria-label="Auto-continue after usage resets"
              type="checkbox"
              checked={preferences.autoContinue}
              onChange={(event) => save({ autoContinue: event.target.checked })}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {onPause ? (
              <button
                disabled={busy}
                className="rounded-md border border-stroke px-3 py-2"
                onClick={() => void run(() => onPause(!preferences.paused))}
              >
                {preferences.paused
                  ? "Restart coordinator"
                  : "Pause coordinator"}
              </button>
            ) : null}
            {onArchive ? (
              <button
                disabled={busy}
                className="rounded-md border border-stroke px-3 py-2"
                onClick={() => void run(onArchive)}
              >
                Archive project
              </button>
            ) : null}
            {onDelete ? (
              <button
                disabled={busy}
                className="rounded-md border border-stroke px-3 py-2 text-red-400"
                onClick={() => void run(onDelete)}
              >
                Delete coordinator…
              </button>
            ) : null}
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}
