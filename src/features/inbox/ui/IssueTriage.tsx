import { useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, X } from "../../../shared/ui/icons";
import { pathKey, projectName } from "../../../shared/lib/paths";
import { TriageModelSettings } from "../../settings/ui/TriageModelSettings";
import {
  applyTriagePlan,
  detachUnstartedIssue,
  eligibleForTriage,
  issueGroupReadiness,
  loadTriageDraft,
  saveTriageDraft,
  startIssueGroup,
  triageBacklog,
  type TriagePreview,
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
  onOpenIssue?: (id: string) => void;
  onOpenSession?: (id: string) => void;
  onRetry?: (id: string) => void;
};

export function useIssueTriage(
  issues: LocalIssue[],
  project: string,
  launch: ((issue: LocalIssue) => Promise<void>) | undefined,
  onError: (reason: unknown) => void,
  controls: TriageControls = {},
) {
  const [preview, setPreview] = useState<TriagePreview | null>(loadTriageDraft);
  const [open, setOpen] = useState(() => !!loadTriageDraft());
  const [configuring, setConfiguring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [includeImages, setIncludeImages] = useState(true);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const scoped = issues.filter(
    (issue) =>
      !issue.archived &&
      (!project || pathKey(issue.projectPath) === pathKey(project)),
  );
  const selected = controls.selectedIds ?? [];
  const candidates = scoped.filter(
    (issue) =>
      eligibleForTriage(issue) &&
      (selected.length
        ? selected.includes(issue.id)
        : !issue.triageGroup &&
          `${issue.title} MC-${issue.number} ${issue.description} ${issue.labels.join(" ")}`
            .toLowerCase()
            .includes((controls.query ?? "").toLowerCase())),
  );
  const groups = [
    ...new Set(scoped.map((issue) => issue.triageGroup?.id).filter(Boolean)),
  ]
    .map((id) =>
      scoped.filter(
        (issue) => issue.triageGroup?.id === id && issue.status !== "done",
      ),
    )
    .filter((group) => group.length);
  const name = (id: string) => {
    const issue = issues.find((entry) => entry.id === id);
    return issue ? `MC-${issue.number}: ${issue.title}` : id;
  };
  const link = (id: string) =>
    controls.onOpenIssue ? (
      <button
        type="button"
        className="it-triage-link"
        onClick={() => controls.onOpenIssue!(id)}
      >
        {name(id)}
      </button>
    ) : (
      <span>{name(id)}</span>
    );
  const persist = (next: TriagePreview | null) => {
    saveTriageDraft(next);
    setPreview(next);
  };
  const edit = (change: (draft: TriagePreview) => void) => {
    if (!preview) return;
    try {
      const next = structuredClone(preview);
      change(next);
      persist(next);
    } catch (reason) {
      onError(reason);
    }
  };
  const run = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setConfiguring(false);
    setOpen(true);
    try {
      const result = await triageBacklog(project, {
        issueIds: candidates.map((issue) => issue.id),
        includeImages,
        signal: controller.signal,
        onProgress: (partial, message) => {
          setProgress(message);
          if (partial.snapshot.length) persist(partial);
        },
      });
      persist(result);
    } catch (reason) {
      onError(reason);
    } finally {
      pending.current = null;
      setBusy(false);
    }
  };
  return {
    button: (
      <button
        className="it-chip"
        disabled={busy || (!candidates.length && !preview)}
        onClick={() => {
          setConfiguring(candidates.length > 0);
          setOpen(true);
        }}
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
      open || groups.length ? (
        <section className="it-triage" aria-label="Issue triage">
          <div className="it-triage-heading">
            <strong>
              {preview ? "Proposed assignments" : "Issue assignments"}
            </strong>
            {!busy && open ? (
              <button
                className="it-icon-button"
                aria-label="Close triage panel"
                onClick={() => {
                  setOpen(false);
                  setConfiguring(false);
                }}
              >
                <X className="it-icon" />
              </button>
            ) : null}
          </div>
          {configuring && !busy ? (
            <div className="it-triage-scope">
              <p>
                {candidates.length} eligible{" "}
                {selected.length ? "selected" : "unassigned backlog"} issues ·{" "}
                {project ? projectName(project) : "all projects"}
                {controls.query ? " · matching your search" : ""}. Accepted
                groups are kept unless you explicitly select their tickets for
                retriage.
              </p>
              {preview ? (
                <p>
                  Your saved proposal will be replaced as new results arrive.
                </p>
              ) : null}
              <label>
                <input
                  type="checkbox"
                  checked={includeImages}
                  onChange={(event) => setIncludeImages(event.target.checked)}
                />
                Include screenshots (requires a vision-capable triage model)
              </label>
              <TriageModelSettings project={project} />
              <button
                className="it-primary"
                disabled={!candidates.length}
                onClick={() => void run()}
              >
                Analyze {candidates.length} issues
              </button>
            </div>
          ) : null}
          {busy ? (
            <div role="status">
              <p>{progress || "Preparing repository inspection…"}</p>
              <button
                className="it-chip"
                onClick={() => {
                  pending.current?.abort();
                  setProgress(
                    "Stopping analysis. The current model request may finish before its workspace is removed.",
                  );
                }}
              >
                Cancel analysis
              </button>
            </div>
          ) : null}
          {preview && open ? (
            <>
              <p className="it-workflow-help">
                Draft saved. Move tickets between groups or choose “Separate
                group” to split them. Triage inspected committed code;
                uncommitted changes were not included. Applying saves
                assignments without starting work.
              </p>
              {preview.warnings?.map((warning, index) => (
                <p className="it-workflow-help" key={index}>
                  {warning}
                </p>
              ))}
              <div className="it-triage-groups">
                {preview.plan.groups.map((group, index) => (
                  <article className="it-triage-group" key={index}>
                    <input
                      className="it-label-input"
                      aria-label={`Group ${index + 1} title`}
                      value={group.title}
                      disabled={busy}
                      onChange={(event) =>
                        edit((next) => {
                          next.plan.groups[index].title = event.target.value;
                        })
                      }
                    />
                    <p>{group.reason}</p>
                    <small>
                      {projectName(
                        preview.snapshot.find(
                          (issue) => issue.id === group.issueIds[0],
                        )?.projectPath ?? "",
                      )}
                    </small>
                    {group.issueIds.map((id) => (
                      <div className="it-triage-member" key={id}>
                        {link(id)}
                        <select
                          aria-label={`Assignment for ${name(id)}`}
                          value={index}
                          disabled={busy}
                          onChange={(event) =>
                            edit((next) => {
                              const target = event.target.value;
                              const source = next.plan.groups[index];
                              source.issueIds = source.issueIds.filter(
                                (entry) => entry !== id,
                              );
                              if (target === "new")
                                next.plan.groups.push({
                                  title: name(id).slice(0, 120),
                                  reason: "Separated for individual execution.",
                                  files: [...source.files],
                                  issueIds: [id],
                                });
                              else {
                                const destination =
                                  next.plan.groups[Number(target)];
                                destination.issueIds.push(id);
                                destination.files = [
                                  ...new Set([
                                    ...destination.files,
                                    ...source.files,
                                  ]),
                                ];
                              }
                              next.plan.groups = next.plan.groups.filter(
                                (entry) => entry.issueIds.length,
                              );
                            })
                          }
                        >
                          {preview.plan.groups.map((target, targetIndex) =>
                            preview.snapshot.find(
                              (issue) => issue.id === target.issueIds[0],
                            )?.projectPath ===
                            preview.snapshot.find((issue) => issue.id === id)
                              ?.projectPath ? (
                              <option key={targetIndex} value={targetIndex}>
                                {target.title}
                              </option>
                            ) : null,
                          )}
                          <option value="new">Separate group</option>
                        </select>
                      </div>
                    ))}
                    {group.files.length ? (
                      <small>{group.files.join(", ")}</small>
                    ) : null}
                  </article>
                ))}
              </div>
              {preview.plan.dependencies.map((dependency, index) => (
                <div key={index} className="it-triage-dependency">
                  {link(dependency.issueId)} depends on{" "}
                  {link(dependency.dependsOn)} · {dependency.reason}
                  <button
                    className="it-chip"
                    disabled={busy}
                    aria-label={`Reject dependency ${name(dependency.issueId)} on ${name(dependency.dependsOn)}`}
                    onClick={() =>
                      edit((next) => {
                        next.plan.dependencies.splice(index, 1);
                      })
                    }
                  >
                    Reject
                  </button>
                </div>
              ))}
              <div className="it-triage-actions it-triage-plan-actions">
                <button
                  className="it-primary"
                  disabled={busy || !preview.plan.groups.length}
                  onClick={() => {
                    try {
                      applyTriagePlan(preview);
                      persist(null);
                      setOpen(false);
                    } catch (reason) {
                      onError(reason);
                    }
                  }}
                >
                  Apply triage plan
                </button>
                <button
                  className="it-chip"
                  disabled={busy}
                  aria-label="Dismiss triage plan"
                  onClick={() => {
                    try {
                      persist(null);
                      setConfiguring(false);
                    } catch (reason) {
                      onError(reason);
                    }
                  }}
                >
                  Discard proposal
                </button>
              </div>
            </>
          ) : null}
          {groups.length ? (
            <details open={open && !preview && !configuring}>
              <summary>
                {groups.length} groups · one thread per assignment
              </summary>
              <div className="it-triage-groups">
                {groups.map((group) => {
                  const first = group[0];
                  const fresh = group.every((issue) =>
                    eligibleForTriage(issue),
                  );
                  const readiness = issueGroupReadiness(group, issues);
                  const running = group.some(isIssueRunning);
                  return (
                    <article
                      className="it-triage-group"
                      key={first.triageGroup!.id}
                    >
                      <strong>
                        {first.triageGroup!.title} · {group.length}
                      </strong>
                      <p>{first.triageGroup!.reason}</p>
                      <small>{projectName(first.projectPath)}</small>
                      {group.map((issue) => (
                        <div className="it-triage-member" key={issue.id}>
                          {link(issue.id)}
                          {issue.workOutcome ? (
                            <small>
                              {issue.workOutcome.status.replace("_", " ")} ·{" "}
                              {issue.workOutcome.summary}
                            </small>
                          ) : null}
                        </div>
                      ))}
                      {readiness ? <p>{readiness}</p> : null}
                      <div className="it-triage-actions">
                        {fresh ? (
                          <button
                            className="it-chip"
                            disabled={!launch || !!readiness}
                            onClick={() =>
                              void startIssueGroup(
                                first.triageGroup!.id,
                                launch!,
                              ).catch(onError)
                            }
                          >
                            Start group
                          </button>
                        ) : null}
                        {first.sessionId && controls.onOpenSession ? (
                          <button
                            className="it-chip"
                            onClick={() =>
                              controls.onOpenSession!(first.sessionId!)
                            }
                          >
                            Open thread
                          </button>
                        ) : null}
                        {!fresh && !running && controls.onOpenIssue ? (
                          <button
                            className="it-chip"
                            onClick={() => controls.onOpenIssue!(first.id)}
                          >
                            Review results
                          </button>
                        ) : null}
                        {!fresh &&
                        !running &&
                        group.some(
                          (issue) =>
                            issue.runState === "failed" ||
                            issue.runState === "cancelled",
                        ) &&
                        controls.onRetry ? (
                          <button
                            className="it-chip"
                            disabled={!!readiness}
                            onClick={() => controls.onRetry!(first.id)}
                          >
                            Retry group
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </details>
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
