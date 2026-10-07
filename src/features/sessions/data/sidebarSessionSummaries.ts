import type { OrchestrationRun } from "../../orchestration/model/orchestration";
import { sameProjectPath } from "../../projects/model/recents";
import { sessionDraftBlock, sessionNeedsInput, type Session } from "../model/session";
import { historyWithLiveSessions, summaryFromSession, type SessionGitHint } from "./sessionHistory";
import { shouldPersistSession, type SessionSummary } from "./sessionStore";

/** Metadata consumed by the sidebar. Never retain transcript blocks here. */
function metadata(session: Session, workerNeedsInput: boolean): readonly unknown[] {
  return [
    session.id, session.cwd, session.harness, session.model, session.runtimeMode,
    session.title, session.providerSessionId, session.worktreeCwd,
    session.worktreeRemoved, session.branch, session.sidebarHidden,
    session.linkedWorkItem, session.automationId, session.orchestrationLeadId,
    !!session.inboxAsk, !!session.ephemeral, !!session.busy,
    !!sessionDraftBlock(session),
    workerNeedsInput ? sessionNeedsInput(session) : session.busy || sessionNeedsInput(session),
    shouldPersistSession(session),
  ];
}

function equalMetadata(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/**
 * Keep list projections stable while only transcript text changes. History and
 * orchestration revisions always rebuild, so saved timestamps/order and worker
 * state remain authoritative. This is deliberately scoped to summary consumers.
 */
export class SidebarSessionSummaries {
  private keys: readonly (readonly unknown[])[] = [];
  private history?: SessionSummary[];
  private runs?: readonly OrchestrationRun[];
  private cwd?: string;
  private branch?: string;
  private repo?: string;
  private workerIds = new Set<string>();
  private result?: { history: SessionSummary[]; open: SessionSummary[] };

  update(
    history: SessionSummary[],
    sessions: Session[],
    cwd: string,
    git: SessionGitHint,
    runs: readonly OrchestrationRun[],
  ): { history: SessionSummary[]; open: SessionSummary[] } {
    if (this.runs !== runs) {
      this.workerIds = new Set(runs.flatMap((run) => run.tasks.map((task) => task.sessionId)));
    }
    const keys = sessions.map((session) => metadata(session, this.workerIds.has(session.id)));
    if (
      this.result && this.history === history && this.runs === runs &&
      this.cwd === cwd && this.branch === git.branch && this.repo === git.repo &&
      keys.length === this.keys.length &&
      keys.every((key, index) => equalMetadata(key, this.keys[index]))
    ) return this.result;

    this.keys = keys;
    this.history = history;
    this.runs = runs;
    this.cwd = cwd;
    this.branch = git.branch;
    this.repo = git.repo;
    this.result = {
      history: historyWithLiveSessions(
        history, sessions.filter((session) => !session.ephemeral), cwd, git, runs,
      ),
      open: sessions.filter((session) =>
        !session.inboxAsk && !session.ephemeral && !session.orchestrationLeadId &&
        sameProjectPath(session.cwd, cwd),
      ).map((session) => summaryFromSession(session, git)),
    };
    return this.result;
  }
}
