import { invoke } from "@tauri-apps/api/core";

export type TaskModelConfig = {
  endpoint: string;
  model: string;
  reasoningEffort: string;
  hasApiKey: boolean;
};

export const taskModelConfig = () =>
  invoke<TaskModelConfig | null>("task_model_config");
export const taskModelModels = (endpoint: string, apiKey: string) =>
  invoke<string[]>("task_model_models", { endpoint, apiKey });
export const saveTaskModel = (
  config: Omit<TaskModelConfig, "hasApiKey"> & { apiKey: string },
) => invoke<TaskModelConfig>("task_model_save", { config });
export const polishIssue = (description: string) =>
  invoke<{ title: string; description: string; priority: number }>(
    "task_model_polish_issue",
    {
      description,
    },
  );
export const taskModelCommitMessage = (args: {
  title: string;
  workSummary: string;
  stat: string;
  diff: string;
  subjectHint: string;
}) => invoke<string>("task_model_commit_message", args);
