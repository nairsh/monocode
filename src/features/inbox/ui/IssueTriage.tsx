import { useRef, useState } from "react";
import { Bot, LoaderCircle, X } from "../../../shared/ui/icons";
import { projectName } from "../../../shared/lib/paths";
import {
  applyTriagePlan,
  startIssueGroup,
  triageBacklog,
  type TriagePreview,
} from "../model/issueTriage";
import {
  isIssueRunning,
  issueBlockers,
  loadLocalIssues,
  updateLocalIssue,
  type LocalIssue,
} from "../model/localIssues";

export function useIssueTriage(
  issues: LocalIssue[],
  project: string,
  launch: ((issue: LocalIssue) => Promise<void>) | undefined,
  onError: (reason: unknown) => void,
) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<TriagePreview | null>(null);
  const [open, setOpen] = useState(false);
  const pending = useRef(false);
  const run = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setOpen(true);
    setPreview(null);
    try {
      setPreview(await triageBacklog(project));
    } catch (reason) {
      onError(reason);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const scoped = issues.filter(
    (issue) => !issue.archived && (!project || issue.projectPath === project),
  );
  const groups = [
    ...new Set(
      scoped
        .map((issue) => issue.triageGroup?.id)
        .filter((id): id is string => !!id),
    ),
  ]
    .map((id) =>
      scoped.filter(
        (issue) => issue.triageGroup?.id === id && issue.status !== "done",
      ),
    )
    .filter((group) => group.length);
  const name = (id: string) => {
    const issue = issues.find((entry) => entry.id === id);
    return issue ? `MC-${issue.number}` : id;
  };
  return {
    button: (
      <button
        className="it-chip"
        disabled={
          busy ||
          !scoped.some(
            (issue) =>
              issue.status === "backlog" &&
              !isIssueRunning(issue) &&
              !issue.sessionId &&
              !issue.runBatchId,
          )
        }
        onClick={() => void run()}
      >
        {busy ? (
          <LoaderCircle className="it-icon animate-spin" />
        ) : (
          <Bot className="it-icon" />
        )}
        Triage
      </button>
    ),
    panel:
      open || groups.length > 0 ? (
        <section className="it-triage" aria-label="Issue triage">
          <div className="it-triage-heading">
            <strong>
              {preview ? "Proposed assignments" : "Issue assignments"}
            </strong>
            {!busy && open ? (
              <button
                className="it-icon-button"
                aria-label="Dismiss triage plan"
                onClick={() => {
                  setPreview(null);
                  setOpen(false);
                }}
              >
                <X className="it-icon" />
              </button>
            ) : null}
          </div>
          {busy ? (
            <p role="status">
              Inspecting the repository in a temporary workspace and grouping
              backlog issues…
            </p>
          ) : null}
          {preview ? (
            <>
              <p className="it-workflow-help">
                Review these groups and dependencies. Each group can run in one
                thread. Triage inspected committed code; uncommitted changes
                were not included.
              </p>
              <div className="it-triage-groups">
                {preview.plan.groups.map((group, index) => (
                  <article className="it-triage-group" key={index}>
                    <strong>
                      {group.title}{" "}
                      <span className="it-muted">
                        · {group.issueIds.length}
                      </span>
                    </strong>
                    <p>{group.reason}</p>
                  <small>{projectName(preview.snapshot.find((issue) => issue.id === group.issueIds[0])!.projectPath)}</small>
                    <small>{group.issueIds.map(name).join(", ")}</small>
                    {group.files.length ? (
                      <small>{group.files.join(", ")}</small>
                    ) : null}
                  </article>
                ))}
              </div>
              {preview.plan.dependencies.map((dependency, index) => (
                <p key={index} className="it-triage-dependency">
                  <strong>
                    {name(dependency.issueId)} depends on{" "}
                    {name(dependency.dependsOn)}
                  </strong>{" "}
                  · {dependency.reason}
                </p>
              ))}
              <button
                className="it-primary"
                onClick={() => {
                  try {
                    applyTriagePlan(preview);
                    setPreview(null);
                    setOpen(false);
                  } catch (reason) {
                    onError(reason);
                  }
                }}
              >
                Apply triage plan
              </button>
            </>
          ) : groups.length ? (
            <details open={open}>
              <summary>
                {groups.length} groups · one thread per assignment
              </summary>
              <div className="it-triage-groups">
                {groups.map((group) => {
                  const first = group[0]!;
                  const blockers = [
                    ...new Set(
                      group
                        .flatMap((issue) =>
                          issueBlockers(
                            issue,
                            issues,
                            group.map((entry) => entry.id),
                          ),
                        )
                        .map((issue) => issue.id),
                    ),
                  ];
                  const fresh = group.every(
                    (issue) =>
                      issue.status === "backlog" &&
                      !issue.sessionId &&
                      !issue.runBatchId &&
                      !isIssueRunning(issue),
                  );
                  return (
                    <article
                      className="it-triage-group"
                      key={first.triageGroup!.id}
                    >
                      <strong>
                        {first.triageGroup!.title}{" "}
                        <span className="it-muted">· {group.length}</span>
                      </strong>
                      <p>{first.triageGroup!.reason}</p>
                    <small>{projectName(first.projectPath)}</small>
                      <small>
                        {group.map((issue) => name(issue.id)).join(", ")}
                      </small>
                      {blockers.length ? (
                        <small>
                          Blocked by {blockers.map(name).join(", ")}
                        </small>
                      ) : null}
                      <button
                        className="it-chip"
                        disabled={!fresh || !launch || blockers.length > 0}
                        onClick={() =>
                          void startIssueGroup(
                            first.triageGroup!.id,
                            launch!,
                          ).catch(onError)
                        }
                      >
                        {group.some(isIssueRunning)
                          ? "Agent working"
                          : group.some((issue) => issue.sessionId)
                            ? "Assigned to a thread"
                            : "Start group"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </details>
          ) : !busy ? (
            <p className="it-workflow-help">
              Triage groups backlog issues by the code they affect and
              identifies prerequisites.
            </p>
          ) : null}
        </section>
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
