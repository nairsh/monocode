import { type ReactNode, useSyncExternalStore } from "react";
import { basename } from "../../../platform/tauri/fs";
import { projectKey } from "../../../shared/lib/paths";
import {
  looksLikeProject,
  type RecentProject,
} from "../../projects/model/recents";
import { CwdPicker } from "../../projects/ui/CwdPicker";
import {
  loadTabGroupLabels,
  resolveTabGroupLabel,
  subscribeTabGroupLabels,
} from "../../workspace/model/tabGroups";
import {
  loadGridArcadeEnabled,
  subscribeGridArcadeEnabled,
} from "../../settings/model/settings";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { TerminalGridBackground } from "../../terminal/ui/TerminalGridBackground";

type Props = {
  cwd: string;
  composer?: ReactNode;
  hasChatBackground?: boolean;
  /** With both, the project name in the heading switches projects. */
  recents?: RecentProject[];
  onCwdChange?: (cwd: string) => void;
};

export function EmptySession({
  cwd,
  composer,
  hasChatBackground,
  recents,
  onCwdChange,
}: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const arcadeEnabled = useSyncExternalStore(
    subscribeGridArcadeEnabled,
    loadGridArcadeEnabled,
    () => true,
  );
  const getProjectLabel = () =>
    looksLikeProject(cwd)
      ? resolveTabGroupLabel(
          projectKey(cwd),
          loadTabGroupLabels(),
          basename(cwd),
        )
      : null;
  const project = useSyncExternalStore(
    subscribeTabGroupLabels,
    getProjectLabel,
    getProjectLabel,
  );
  const title = project
    ? `What should we work on in ${project}?`
    : "What should we work on?";

  return (
    <div
      ref={lockOverscroll}
      className="relative flex h-full min-h-0 overflow-y-auto overscroll-none"
    >
      {arcadeEnabled && !hasChatBackground ? <TerminalGridBackground /> : null}
      {composer ? (
        // Same box as the docked composer (max-w-3xl, p-1.5), so the input
        // keeps its width when the first message docks it.
        <div className="pointer-events-none relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-1.5 py-12">
          <div className="pointer-events-auto mb-4 px-2.5">
            {project && recents && onCwdChange ? (
              <h1 className="flex min-w-0 items-baseline whitespace-pre text-lg text-content">
                <span className="shrink-0">What should we work on in </span>
                <CwdPicker
                  cwd={cwd}
                  recents={recents}
                  placement="below"
                  onCwdChange={onCwdChange}
                  buttonClassName="min-w-0 truncate rounded-sm underline decoration-content/40 decoration-dotted decoration-1 underline-offset-4"
                >
                  {project}
                </CwdPicker>
                <span className="shrink-0">?</span>
              </h1>
            ) : (
              <h1
                className="truncate text-lg text-content"
                title={project ? cwd : undefined}
              >
                {title}
              </h1>
            )}
          </div>

          <div className="pointer-events-auto w-full">{composer}</div>
        </div>
      ) : null}
    </div>
  );
}
