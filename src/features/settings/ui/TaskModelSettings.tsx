import { useEffect, useState } from "react";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import {
  saveTaskModel,
  taskModelConfig,
  taskModelModels,
} from "../model/taskModel";

export function TaskModelSettings() {
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void taskModelConfig()
      .then((config) => {
        if (cancelled || !config) return;
        setEndpoint(config.endpoint);
        setModel(config.model);
        setModels([config.model]);
        setReasoningEffort(config.reasoningEffort);
        setHasApiKey(config.hasApiKey);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const inputClass =
    "h-8 w-full rounded-md border border-content/10 bg-transparent px-2 text-content outline-none focus:border-content/20";
  return (
    <form
      className="flex flex-col gap-3 px-4 py-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const config = await saveTaskModel({
            endpoint,
            apiKey,
            model,
            reasoningEffort,
          });
          setEndpoint(config.endpoint);
          setApiKey("");
          setHasApiKey(config.hasApiKey);
          setSaved(true);
        });
      }}
    >
      <p className="text-[12px] text-content/45">
        Generates issue titles and polishes descriptions when you create an
        issue. Your description is sent to this endpoint.
      </p>
      <fieldset
        disabled={busy}
        className="flex flex-col gap-3 disabled:opacity-60"
      >
        <label className="text-[12px] text-content/65">
          API base URL
          <input
            className={inputClass}
            aria-label="Task model endpoint"
            placeholder="https://your-endpoint/v1"
            value={endpoint}
            required
            onChange={(event) => {
              setEndpoint(event.target.value);
              setModels([]);
              setModel("");
              setHasApiKey(false);
              setSaved(false);
            }}
          />
        </label>
        <label className="text-[12px] text-content/65">
          API key (optional)
          <input
            className={inputClass}
            aria-label="Task model API key"
            type="password"
            autoComplete="off"
            placeholder={
              hasApiKey ? "Saved key; leave blank to keep" : "API key"
            }
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setModels([]);
              setModel("");
              setSaved(false);
            }}
          />
        </label>
        <SecondaryButton
          type="button"
          disabled={!endpoint.trim()}
          onClick={() =>
            void run(async () => {
              const next = await taskModelModels(endpoint, apiKey);
              setModels(next);
              setModel((previous) =>
                next.includes(previous) ? previous : (next[0] ?? ""),
              );
            })
          }
        >
          Load models
        </SecondaryButton>
        <label className="text-[12px] text-content/65">
          Model
          <select
            className={inputClass}
            aria-label="Task model"
            value={model}
            required
            onChange={(event) => {
              setModel(event.target.value);
              setSaved(false);
            }}
          >
            <option value="">Load and choose a model</option>
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] text-content/65">
          Reasoning effort
          <select
            className={inputClass}
            aria-label="Task model reasoning effort"
            value={reasoningEffort}
            onChange={(event) => {
              setReasoningEffort(event.target.value);
              setSaved(false);
            }}
          >
            <option value="">Provider default</option>
            {["none", "minimal", "low", "medium", "high", "xhigh"].map(
              (effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ),
            )}
          </select>
        </label>
        <p className="text-[12px] text-content/45">
          Choose an effort supported by your model, or use the provider default.
        </p>
        <SecondaryButton type="submit" disabled={!endpoint.trim() || !model}>
          Save task model
        </SecondaryButton>
      </fieldset>
      {busy ? <p className="text-[12px] text-content/45">Loading…</p> : null}
      {saved ? (
        <p role="status" className="text-[12px] text-content/65">
          Task model saved.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-red-400">
          {error}
        </p>
      ) : null}
    </form>
  );
}
