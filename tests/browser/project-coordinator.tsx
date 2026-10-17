import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MonoOverview,
  type MonoOverviewTab,
} from "../../src/features/monos/ui/MonoOverview";
import { MonoSettingsDialog } from "../../src/features/monos/ui/MonoSettingsDialog";
import { MonoHeader } from "../../src/features/monos/ui/MonoHeader";
import { MonoComposer } from "../../src/features/monos/ui/MonoComposer";
import { SessionCard } from "../../src/app/shell/Sidebar";
import {
  newSession,
  type Session,
} from "../../src/features/sessions/model/session";
import {
  ensureProjectCoordinator,
  projectCoordinatorPreferences,
  updateProjectCoordinator,
} from "../../src/features/projects/model/projectCoordinator";
import { findMono, monoLook } from "../../src/features/monos/model/mono";
import { summaryFromSession } from "../../src/features/sessions/data/sessionHistory";
import type { Artifact } from "../../src/features/artifacts/artifacts";
import "../../src/styles/index.css";

// Isolated browser fixture. Native persistence/provider calls are simulated here;
// the components, grouping, preferences, imports, and filtering are production code.
const id = ensureProjectCoordinator("/qa/monocode");
const agent = monoLook(findMono(id)!);
const drafts = ["Audit the issue workflow", "Polish keyboard navigation"].map(
  (title, index): Session => ({
    ...newSession("codex", "/qa/monocode"),
    id: `draft-${index}`,
    title,
    blocks: [{ id: `prompt-${index}`, role: "user", text: title, draft: true }],
  }),
);
const settled: Session = {
  ...newSession("claude", "/qa/monocode"),
  id: "settled",
  title: "Document project conventions",
  blocks: [
    {
      id: "done",
      role: "assistant",
      text: "Finished documenting the conventions.",
    },
  ],
};
const waiting: Session = {
  ...newSession("codex", "/qa/monocode"),
  id: "waiting",
  title: "Review authentication changes",
  pendingQuestion: {
    requestId: 1,
    questions: [
      {
        id: "q",
        prompt: "Which compatibility target?",
        options: [],
        multiSelect: false,
        allowCustom: true,
      },
    ],
  },
};
let nativeSessions = [...drafts, waiting, settled];
const artifacts = new Map<string, Artifact>();
const agentFiles: Record<string, string> = {
  "habits.json": "[]",
  "MEMORY.md": "# Memory\n",
  "SOUL.md": "Be a careful project coordinator.",
};
Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "qa" },
      currentWebview: { label: "qa" },
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command.startsWith("plugin:event|")) return 1;
      if (command === "session_list_by_project")
        return nativeSessions.map((session) => summaryFromSession(session));
      if (command === "session_get") return null;
      if (command === "mono_read")
        return { text: agentFiles[args.path] ?? null, hash: "fixture" };
      if (command === "mono_save") {
        agentFiles[args.path] = args.text;
        return "fixture";
      }
      if (command === "mono_load")
        return {
          id,
          dir: "/qa/memory",
          soul: agentFiles["SOUL.md"],
          soulHash: "fixture",
          memory: agentFiles["MEMORY.md"],
          memoryHash: "fixture",
          memoryPath: "/qa/memory/MEMORY.md",
          topics: [],
        };
      if (command === "artifacts_list") return [...artifacts.values()];
      if (command === "artifacts_upsert") {
        const artifact = {
          ...args.artifact,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as Artifact;
        artifacts.set(artifact.id, artifact);
        return artifact;
      }
      if (command === "artifacts_get") return artifacts.get(args.id) ?? null;
      if (command === "list_models") return [];
      if (command === "list_worktrees") return { worktrees: [] };
      throw new Error(`Unsupported native call in QA fixture: ${command}`);
    },
  },
});
function Fixture() {
  const [sessions, setSessions] = useState(nativeSessions);
  const [tab, setTab] = useState<MonoOverviewTab>("sessions");
  const [open, setOpen] = useState(true);
  const [settings, setSettings] = useState(false);
  const [message, setMessage] = useState(
    "The project has two suggested threads and one thread waiting for your input.",
  );
  const launches = sessions.map((session) => ({
    sessionId: session.id,
    cwd: session.cwd,
    title: session.title,
    harness: session.harness,
    model: session.model,
  }));
  return (
    <div className="flex h-screen min-w-0 flex-col bg-background-base text-content">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-stroke px-4 text-[12px]">
        <span className="font-medium">{agent.name}</span>
        <span className="text-content/40">
          Cloud QA fixture · provider and native bridge simulated
        </span>
        <button className="ml-auto" onClick={() => setOpen(!open)}>
          Overview
        </button>
        <button onClick={() => setSettings(true)}>Project settings</button>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-stroke p-3 md:block">
          <p className="mb-3 text-[11px] text-content/40">Project threads</p>
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={{
                ...summaryFromSession(session),
                repo: "monocode",
                branch: session.id === "settled" ? "main" : "work/project",
              }}
              isActive={false}
              isSelected={false}
              busy={!!session.busy}
              done={session.id === "settled"}
              linkedUpdate={false}
              needsApproval={session.id === "waiting"}
              spawnedBy={agent.name}
              now={Date.now()}
              onSelect={() => {}}
              onContextMenu={() => {}}
            />
          ))}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <MonoHeader agent={agent} />
          <div className="mx-auto max-w-lg flex-1 px-6 text-[14px] leading-7 text-content/70">
            {message}
          </div>
          <div className="mx-auto w-full max-w-2xl px-4 pb-6">
            <MonoComposer
              sessionId="qa-coordinator"
              name={agent.name}
              onSubmit={(text) => {
                setMessage(text);
                return true;
              }}
            />
          </div>
        </main>
        <MonoOverview
          open={open}
          monoId={id}
          cwd="/qa/monocode"
          agent={agent}
          state={{ status: "idle" }}
          launches={launches}
          sessions={sessions}
          documents={[]}
          tab={tab}
          onTabChange={setTab}
          onOpenSession={(sessionId) => setMessage(`Opened ${sessionId}`)}
          onOpenDocument={(artifactId) =>
            setMessage(
              `Opened library artifact ${artifacts.get(artifactId)?.title}`,
            )
          }
          onClose={() => setOpen(false)}
          coordinatorSessionId="qa-coordinator"
          onStartSession={async (sessionId) => {
            nativeSessions = nativeSessions.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    busy: true,
                    blocks: session.blocks.map((block) => ({
                      ...block,
                      draft: false,
                    })),
                  }
                : session,
            );
            setSessions(nativeSessions);
          }}
        />
      </div>
      {settings ? (
        <MonoSettingsDialog
          monoId={id}
          agent={agent}
          cwd="/qa/monocode"
          status="idle"
          harness="codex"
          model="gpt-6"
          modelSettings={{}}
          runtimeMode="supervised"
          onModelChange={() => {}}
          onModelSettingsChange={() => {}}
          onRuntimeModeChange={() => {}}
          onPause={async (paused) => updateProjectCoordinator(id, { paused })}
          onArchive={async () =>
            updateProjectCoordinator(id, { archived: true })
          }
          onClose={() => setSettings(false)}
        />
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
