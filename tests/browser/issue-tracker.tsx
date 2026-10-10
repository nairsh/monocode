import React from "react";
import { createRoot } from "react-dom/client";
import { IssueTracker } from "../../src/features/inbox/ui/IssueTracker";
import {
  createLocalIssue,
  LOCAL_ISSUES_KEY,
  updateLocalIssue,
} from "../../src/features/inbox/model/localIssues";
import "../../src/styles/index.css";

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "qa" },
      currentWebview: { label: "qa" },
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (command: string) => {
      if (command.startsWith("plugin:event|")) return 1;
      if (command === "list_models") return [];
      throw new Error(
        `Native command unavailable in browser fixture: ${command}`,
      );
    },
  },
});

// This fixture uses its own browser origin and never touches desktop app data.
if (!localStorage.getItem(LOCAL_ISSUES_KEY)) {
  for (const [topic, titles] of [
    [
      "Streaming",
      ["Keep streamed messages in order", "Reconnect interrupted responses"],
    ],
    [
      "Issue workflow",
      ["Clarify verification controls", "Improve issue creation"],
    ],
    ["Navigation", ["Keep active threads in a stable order"]],
  ] as const) {
    for (const title of titles) {
      const issue = createLocalIssue({
        title,
        description:
          "## Task\n\nImprove the interaction while preserving existing behavior.\n\n## Acceptance criteria\n\n- Changes appear immediately\n- Keyboard navigation remains available",
        projectPath: "/qa/project",
        status: "backlog",
        priority: topic === "Streaming" ? 2 : 3,
        agent: "",
        labels: ["UI"],
      });
      updateLocalIssue(issue.id, {
        triageGroup: {
          id: topic,
          title: topic,
          reason: "Shared implementation context",
          files: ["src/app.ts"],
        },
      });
    }
  }
}
document.documentElement.setAttribute("data-theme", "dark");
document.documentElement.style.cssText =
  "color-scheme:dark;--color-background-base:#101010;--color-content:#eee;--color-stroke:#ffffff0d;--color-selection-hover:#ffffff0a;--color-accent:#8880ff";
document.body.style.margin = "0";
createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh" }}>
    <IssueTracker cwd="/qa/project" recents={[]} onLaunch={async () => {}} />
  </div>,
);
