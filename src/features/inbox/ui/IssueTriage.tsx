import { useEffect, useRef, useState } from "react";
import { Bot, X } from "../../../shared/ui/icons";
import { pathKey } from "../../../shared/lib/paths";
import { TriageModelSettings } from "../../settings/ui/TriageModelSettings";
import { Popover } from "../../../shared/ui/Popover";
import {
  applyTriagePlan,
  detachUnstartedIssue,
  eligibleForTriage,
  triageBacklog,
  undoTriage,
  type TriageUndo,
} from "../model/issueTriage";
import {
  isIssueRunning,
  loadLocalIssues,
  updateLocalIssue,
  type LocalIssue,
} from "../model/localIssues";

type TriageControls = {
  selectedIds?: string[];
  query?: string;
  onApplied?: () => void;
};

export function useIssueTriage(
  issues: LocalIssue[],
  project: string,
  _launch: ((issue: LocalIssue) => Promise<void>) | undefined,
  onError: (reason: unknown) => void,
  controls: TriageControls = {},
) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [receipts, setReceipts] = useState<TriageUndo[]>([]);
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);
  const candidates = issues.filter(
    (issue) =>
      eligibleForTriage(issue) &&
      (!project || pathKey(issue.projectPath) === pathKey(project)) &&
      (controls.selectedIds?.length
        ? controls.selectedIds.includes(issue.id)
        : !issue.triageGroup &&
          `${issue.title} MC-${issue.number} ${issue.description} ${issue.labels.join(" ")}`
            .toLowerCase()
            .includes((controls.query ?? "").toLowerCase())),
  );
  const run = async () => {
    if (pending.current || !candidates.length) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setNotice("");
    setReceipts([]);
    setProgress("Preparing repository inspection…");
    const applied: TriageUndo[] = [];
    try {
      const result = await triageBacklog(project, {
        issueIds: candidates.map((issue) => issue.id),
        includeImages: true,
        signal: controller.signal,
        onProgress: (_partial, message) => {
          if (mounted.current) setProgress(message);
        },
        onBatch: (batch) => {
          if (controller.signal.aborted) return;
          applied.push(applyTriagePlan(batch));
          if (mounted.current) {
            setReceipts([...applied]);
            controls.onApplied?.();
          }
        },
      });
      if (mounted.current) {
        const count = applied.reduce(
          (n, receipt) => n + receipt.after.length,
          0,
        );
        setNotice(
          `${count} issues triaged · ${result.plan.groups.length} topics${result.warnings?.length ? " · " + result.warnings.join(" ") : ""}`,
        );
      }
    } catch (reason) {
      if (mounted.current) {
        if (controller.signal.aborted)
          setNotice(
            applied.length
              ? "Triage stopped. Completed changes can be undone."
              : "Triage cancelled",
          );
        else onError(reason);
      }
    } finally {
      pending.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    busy,
    button: (
      <div className="it-triage-control">
        <button
          className="it-chip"
          disabled={busy || !candidates.length}
          onClick={() => void run()}
          title={`Triage ${candidates.length} eligible issues`}
        >
          <Bot className="it-icon" />
          <span className={busy ? "it-shimmer" : ""}>
            {busy ? "Triaging…" : "Triage"}
          </span>
        </button>
        <button
          className="it-icon-button"
          aria-label="Triage settings"
          onClick={(event) => setSettings(event.currentTarget)}
        >
          ⌄
        </button>
        {settings ? (
          <Popover
            anchor={settings}
            width={320}
            ignore="[data-popover-layer]"
            onDismiss={() => setSettings(null)}
            className="issue-surface it-triage-settings"
          >
            <strong>Triage model</strong>
            <p className="it-muted">
              Groups related work and improves issue details. Changes apply
              automatically and can be undone.
            </p>
            <TriageModelSettings project={project} />
          </Popover>
        ) : null}
      </div>
    ),
    panel:
      busy || notice ? (
        <div className="it-triage-toast" role="status" aria-live="polite">
          <Bot className="it-icon" />
          <div>
            <strong className={busy ? "it-shimmer" : ""}>
              {busy ? "Triaging your issues" : notice}
            </strong>
            {busy ? <span className="it-muted">{progress}</span> : null}
          </div>
          {busy ? (
            <button
              className="it-chip"
              onClick={() => {
                pending.current?.abort();
                setProgress("Stopping triage…");
              }}
            >
              Cancel
            </button>
          ) : (
            <>
              {receipts.length ? (
                <button
                  className="it-chip"
                  onClick={() => {
                    try {
                      const count = undoTriage(receipts);
                      setReceipts([]);
                      setNotice(
                        count
                          ? `Undid triage for ${count} issues. Later edits were kept.`
                          : "Issues already started or changed; nothing to undo.",
                      );
                    } catch (reason) {
                      onError(reason);
                    }
                  }}
                >
                  Undo changes
                </button>
              ) : null}
              <button
                className="it-icon-button"
                aria-label="Dismiss triage notification"
                onClick={() => setNotice("")}
              >
                <X className="it-icon" />
              </button>
            </>
          )}
        </div>
      ) : null,
  };
}

export function IssueDependencies({
  issue,
  onError,
}: {
  issue: LocalIssue;
  onError: (reason: unknown) => void;
}) {
  const issues = loadLocalIssues();
  const related = issues.filter(
    (entry) =>
      entry.projectPath === issue.projectPath &&
      entry.id !== issue.id &&
      !entry.archived,
  );
  const dependencies = (issue.dependsOn ?? [])
    .map((id) => issues.find((entry) => entry.id === id))
    .filter((entry): entry is LocalIssue => !!entry);
  const blocking = issues.filter((entry) =>
    entry.dependsOn?.includes(issue.id),
  );
  return (
    <>
      {issue.triageGroup ? (
        <>
          <h3>Assignment group</h3>
          <p className="it-workflow-help">
            {issue.triageGroup.title}
            {issue.runBatchId ? " · shared thread, review and commit" : ""}
          </p>
          {!issue.sessionId && !issue.runBatchId && !isIssueRunning(issue) ? (
            <button
              className="it-chip"
              onClick={() => {
                try {
                  detachUnstartedIssue(issue.id);
                } catch (reason) {
                  onError(reason);
                }
              }}
            >
              Detach from group
            </button>
          ) : null}
        </>
      ) : null}
      {issue.workOutcome ? (
        <>
          <h3>Ticket result</h3>
          <p className="it-workflow-help">
            {issue.workOutcome.status.replace("_", " ")} ·{" "}
            {issue.workOutcome.summary}
          </p>
          {issue.workOutcome.status !== "ready" && !isIssueRunning(issue) ? (
            <button
              className="it-chip"
              onClick={() => {
                try {
                  updateLocalIssue(
                    issue.id,
                    {
                      status: "in_review",
                      workOutcome: {
                        status: "ready",
                        summary: "Confirmed ready for review by the user.",
                      },
                    },
                    "Confirmed this ticket is ready for review",
                  );
                } catch (reason) {
                  onError(reason);
                }
              }}
            >
              Confirm ticket ready for review
            </button>
          ) : null}
        </>
      ) : null}
      <h3>Depends on</h3>
      {dependencies.map((dependency) => (
        <div className="it-dependency-row" key={dependency.id}>
          <span title={dependency.title}>
            MC-{dependency.number} ·{" "}
            {dependency.status === "done" ? "Done" : dependency.title}
          </span>
          <button
            className="it-icon-button"
            disabled={isIssueRunning(issue)}
            aria-label={`Remove dependency MC-${dependency.number}`}
            onClick={() => {
              try {
                updateLocalIssue(
                  issue.id,
                  {
                    dependsOn: issue.dependsOn!.filter(
                      (id) => id !== dependency.id,
                    ),
                  },
                  `Removed dependency MC-${dependency.number}`,
                );
              } catch (reason) {
                onError(reason);
              }
            }}
          >
            <X className="it-icon" />
          </button>
        </div>
      ))}
      <select
        className="it-label-input"
        aria-label="Add issue dependency"
        value=""
        disabled={isIssueRunning(issue)}
        onChange={(event) => {
          const id = event.target.value;
          if (!id) return;
          try {
            updateLocalIssue(
              issue.id,
              { dependsOn: [...(issue.dependsOn ?? []), id] },
              `Added dependency MC-${issues.find((entry) => entry.id === id)!.number}`,
            );
          } catch (reason) {
            onError(reason);
          }
        }}
      >
        <option value="">Add prerequisite…</option>
        {related
          .filter((entry) => !issue.dependsOn?.includes(entry.id))
          .map((entry) => (
            <option key={entry.id} value={entry.id}>
              MC-{entry.number} · {entry.title}
            </option>
          ))}
      </select>
      {blocking.length ? (
        <>
          <h3>Blocks</h3>
          <p className="it-workflow-help">
            {blocking.map((entry) => `MC-${entry.number}`).join(", ")}
          </p>
        </>
      ) : null}
    </>
  );
}
