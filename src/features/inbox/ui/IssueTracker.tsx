import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { loadIssueImages, type IssueImage } from "../model/localIssueImages";
import { AttachmentChip } from "../../sessions/ui/AttachmentChip";
import type { Attachment } from "../../sessions/model/session";
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Copy,
  DashboardSquare,
  Folder,
  Inbox,
  ListBullet,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  X,
} from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { copyText } from "../../../platform/tauri/clipboard";
import { LAYER } from "../../../shared/lib/layers";
import { projectName } from "../../../shared/lib/paths";
import {
  sameProjectPath,
  collectRailProjects,
  type RecentProject,
} from "../../projects/model/recents";
import {
  HARNESS_LABEL,
  type Block,
  type Session,
} from "../../sessions/model/session";
import {
  defaultSessionChoice,
  preferredModelSettings,
  resolveModel,
  preferredModelId,
} from "../../sessions/model/models";
import { ModelPicker } from "../../sessions/ui/ModelPicker";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { IssueImages } from "./IssueImages";
import {
  createLocalIssue,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  loadLocalIssues,
  localIssuePrompt,
  moveLocalIssue,
  startLocalIssue,
  subscribeLocalIssues,
  updateLocalIssue,
  type IssueDraft,
  type IssueStatus,
  type LocalIssue,
} from "../model/localIssues";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";
import { AgentTranscript } from "../../sessions/ui/AgentTranscript";
import type { ApprovalDecision } from "../../../integrations/harness";
import "./IssueTracker.css";

type View = "issues" | "archive";
type Scope = "active" | "backlog" | "all";
type Option = { value: string; label: string; icon?: ReactNode; hint?: string };
type Props = {
  cwd: string;
  recents: RecentProject[];
  onLaunch?: (issue: LocalIssue) => Promise<void>;
  onOpenSession?: (id: string) => void | Promise<void>;
  onReadSession?: (id: string) => Promise<Session | null | undefined>;
  onApproval?: (
    sessionId: string,
    requestId: number,
    decision: ApprovalDecision,
  ) => void;
};

function StatusIcon({ status }: { status: IssueStatus }) {
  return (
    <img
      src={`/issue-status/${status}.svg`}
      alt=""
      className={`it-icon it-status it-status-${status}`}
      aria-hidden
    />
  );
}
const STATUS_OPTIONS: Option[] = ISSUE_STATUSES.map((status, index) => ({
  value: status,
  label: ISSUE_STATUS_LABELS[status],
  icon: <StatusIcon status={status} />,
  hint: String(index + 1),
}));
const PRIORITY_OPTIONS: Option[] = ISSUE_PRIORITIES.map((label, value) => ({
  value: String(value),
  label,
  icon:
    value === 0 ? (
      <MoreHorizontal className="it-icon it-priority" />
    ) : (
      <ListFilter className={`it-icon it-priority it-priority-${value}`} />
    ),
}));

function IssueOutput({
  text,
  cwd,
  images,
  evidenceError,
}: {
  text: string;
  cwd: string;
  images?: IssueImage[];
  evidenceError?: string;
}) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void loadIssueImages(images).then(
      (files) => {
        if (alive) setFiles(files);
      },
      (reason) => {
        if (alive) setError(String(reason));
      },
    );
    return () => {
      alive = false;
    };
  }, [images]);
  return (
    <>
      <AgentMarkdown text={text} cwd={cwd} />
      <div className="it-proof">
        {files.map((file) => (
          <AttachmentChip key={file.id} attachment={file} large />
        ))}
      </div>
      {evidenceError || error ? (
        <p className="it-error">{evidenceError || error}</p>
      ) : null}
    </>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  children,
  className = "it-chip",
  disabled = false,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const menuSearch = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (anchor) menuSearch.current?.focus();
  }, [anchor]);
  const choices = options.filter((option) =>
    option.label.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(event) => {
          setQuery("");
          setAnchor(event.currentTarget);
        }}
      >
        {children}
      </button>
      {anchor ? (
        <Popover
          bare
          anchor={anchor}
          width={248}
          layer={LAYER.dialogPopover}
          onDismiss={() => setAnchor(null)}
          className="issue-surface it-menu"
          data-dialog-popover
        >
          <input
            ref={menuSearch}
            autoFocus
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`${label}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>("[role=menuitemradio]")
                  ?.focus();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setAnchor(null);
                anchor.focus();
              }
            }}
          />
          <div
            role="menu"
            aria-label={label}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button",
                  ),
                ];
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                buttons[
                  (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                    buttons.length
                ]?.focus();
              }
            }}
          >
            {choices.map((option) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={value === option.value}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setAnchor(null);
                  anchor.focus();
                }}
              >
                {option.icon}
                <span>{option.label}</span>
                {value === option.value ? (
                  <Check className="it-icon" />
                ) : option.hint ? (
                  <kbd>{option.hint}</kbd>
                ) : null}
              </button>
            ))}
            {choices.length === 0 ? (
              <p className="it-muted it-menu-empty">No results</p>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function IssueDialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    if (root) root.inert = true;
    (
      dialog.current?.querySelector<HTMLElement>("input, textarea") ??
      dialog.current?.querySelector<HTMLElement>("button")
    )?.focus();
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector("[data-dialog-popover]")
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key === "Tab") {
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']",
          ) ?? []),
        ];
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (root) root.inert = wasInert ?? false;
      if (previousFocus.current instanceof HTMLElement)
        previousFocus.current.focus();
    };
  }, []);
  return createPortal(
    <div
      className={`it-dialog-backdrop ${wide ? "it-dialog-backdrop-wide" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        className={`issue-surface it-dialog ${wide ? "it-dialog-wide" : ""}`}
        aria-label={title}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function NewIssue({
  project,
  projects,
  status,
  onClose,
  onCreate,
}: {
  project: string;
  projects: string[];
  status: IssueStatus;
  onClose: () => void;
  onCreate: (draft: IssueDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<IssueDraft>(() => {
    const choice = defaultSessionChoice(project);
    return {
      title: "",
      description: "",
      status,
      priority: 0,
      projectPath: project,
      labels: [],
      agent: choice.harness,
      model: choice.model,
      modelSettings: preferredModelSettings(
        resolveModel(choice.harness, choice.model),
      ),
      images: [],
    };
  });
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imagesBusy, setImagesBusy] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const change = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const dismiss = () => {
    if (imagesBusy) setError("Wait for the images to finish saving.");
    else onClose();
  };
  const submit = async () => {
    if (busy || imagesBusy || !draft.title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onCreate(draft);
      if (more) {
        setDraft((previous) => ({
          ...previous,
          title: "",
          description: "",
          images: [],
        }));
        titleRef.current?.focus();
      } else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <IssueDialog title="Create issue" onClose={dismiss}>
      <form
        data-session-drop
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <header className="it-dialog-header">
          <span className="it-chip">
            <Folder className="it-icon it-teal" />
            MC
          </span>
          <ChevronRight className="it-icon" />
          <span>New issue</span>
          <button
            type="button"
            className="it-icon-button it-push"
            aria-label="Close create issue"
            onClick={dismiss}
          >
            <X className="it-icon" />
          </button>
        </header>
        <div className="it-create-fields">
          <input
            autoFocus
            ref={titleRef}
            className="it-create-title"
            placeholder="Issue title"
            aria-label="Issue title"
            value={draft.title}
            onChange={(event) => change("title", event.target.value)}
            required
          />
          <textarea
            className="it-description"
            placeholder="Add description…"
            aria-label="Issue description"
            value={draft.description}
            onChange={(event) => change("description", event.target.value)}
          />
          <IssueImages
            images={draft.images}
            onChange={(value) => change("images", value)}
            onError={(reason) =>
              setError(
                reason instanceof Error ? reason.message : String(reason),
              )
            }
            onBusy={setImagesBusy}
            disabled={busy}
          />
          <IssueProperties
            draft={draft}
            projects={projects}
            onChange={change}
          />
          <input
            className="it-label-input"
            aria-label="Issue labels"
            placeholder="Labels, separated by commas"
            value={draft.labels.join(",")}
            onChange={(event) =>
              change("labels", event.target.value.split(","))
            }
          />
          {draft.status === "todo" ? (
            <p className="it-dispatch-note">
              <Bot className="it-icon" />
              Creating in To Do starts the selected agent in a dedicated thread.
            </p>
          ) : null}
          {error ? (
            <p className="it-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="it-create-footer">
          <span className="it-muted">Saved on this device</span>
          <label className="it-create-more">
            <input
              type="checkbox"
              checked={more}
              onChange={(event) => setMore(event.target.checked)}
            />
            Create more
          </label>
          <button
            className="it-primary"
            type="submit"
            disabled={busy || imagesBusy || !draft.title.trim()}
          >
            {busy ? <LoaderCircle className="it-icon animate-spin" /> : null}
            Create issue
          </button>
        </footer>
      </form>
    </IssueDialog>
  );
}

function IssueProperties({
  draft,
  projects,
  onChange,
  disabled = false,
}: {
  draft: IssueDraft;
  projects: string[];
  onChange: <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) => void;
  disabled?: boolean;
}) {
  const choice = defaultSessionChoice(draft.projectPath);
  const harness = draft.agent || choice.harness;
  const model =
    draft.model || (draft.agent ? preferredModelId(harness) : choice.model);
  const values =
    draft.modelSettings || preferredModelSettings(resolveModel(harness, model));
  return (
    <div className="it-properties">
      <Choice
        label="Change status"
        value={draft.status}
        options={STATUS_OPTIONS}
        onChange={(value) => onChange("status", value as IssueStatus)}
        disabled={disabled}
      >
        <StatusIcon status={draft.status} />
        {ISSUE_STATUS_LABELS[draft.status]}
      </Choice>
      <Choice
        label="Change priority"
        value={String(draft.priority)}
        options={PRIORITY_OPTIONS}
        onChange={(value) => onChange("priority", Number(value))}
      >
        <span className={`it-priority it-priority-${draft.priority}`}>
          {draft.priority ? (
            <ListFilter className="it-icon" />
          ) : (
            <MoreHorizontal className="it-icon" />
          )}
        </span>
        {draft.priority ? ISSUE_PRIORITIES[draft.priority] : "Priority"}
      </Choice>
      <div
        className="it-model-choice"
        inert={disabled}
        aria-disabled={disabled}
      >
        <ModelPicker
          variant="plain"
          harness={harness}
          model={model}
          values={values}
          project={draft.projectPath}
          side="bottom"
          hotkeys={false}
          onChange={(agent, selectedModel) => {
            onChange("agent", agent);
            onChange("model", selectedModel);
            onChange(
              "modelSettings",
              preferredModelSettings(resolveModel(agent, selectedModel)),
            );
          }}
          onSettingsChange={(settings) => onChange("modelSettings", settings)}
        />
      </div>
      <Choice
        label="Change project"
        value={draft.projectPath}
        options={[
          {
            value: "",
            label: "No project",
            icon: <Folder className="it-icon" />,
          },
          ...projects.map((path) => ({
            value: path,
            label: projectName(path),
            icon: <Folder className="it-icon" />,
          })),
        ]}
        onChange={(value) => onChange("projectPath", value)}
        disabled={disabled}
      >
        <Folder className="it-icon" />
        {draft.projectPath ? projectName(draft.projectPath) : "Project"}
      </Choice>
    </div>
  );
}

function IssueDetail({
  issue,
  projects,
  onClose,
  onMove,
  onRetry,
  onContinue,
  onReadSession,
  onApproval,
  onOpenSession,
  onError: reportGlobalError,
}: {
  issue: LocalIssue;
  projects: string[];
  onClose: () => void;
  onMove: (id: string, status: IssueStatus) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onContinue: (
    id: string,
    feedback?: string,
    kind?: "work" | "commit",
  ) => Promise<void>;
  onReadSession?: Props["onReadSession"];
  onApproval?: Props["onApproval"];
  onOpenSession?: Props["onOpenSession"];
  onError: (reason: unknown) => void;
}) {
  const [draft, setDraft] = useState<IssueDraft>(issue);
  const [comment, setComment] = useState("");
  const [editingDescription, setEditingDescription] = useState(false);
  const [saving, setSaving] = useState(false);
  const [imagesBusy, setImagesBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const historicalBlockIds = useMemo(
    () => new Set(blocks.map((block) => block.id)),
    [blocks],
  );
  useEffect(() => {
    if (!issue.sessionId || !onReadSession) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const session = await onReadSession(issue.sessionId!);
        if (!disposed) setBlocks(session?.blocks ?? []);
      } catch (reason) {
        if (!disposed)
          setDetailError(
            reason instanceof Error ? reason.message : String(reason),
          );
      }
      if (!disposed) timer = setTimeout(refresh, 2500);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [issue.sessionId, onReadSession]);
  const onError = (reason: unknown) => {
    setDetailError(reason instanceof Error ? reason.message : String(reason));
    reportGlobalError(reason);
  };
  const running = issue.runState === "starting" || issue.runState === "running";
  const persist = () => {
    if (!draft.title.trim()) throw new Error("Give the issue a title.");
    return updateLocalIssue(issue.id, {
      title: draft.title,
      description: draft.description,
      labels: draft.labels,
    });
  };
  const saveAndClose = () => {
    if (imagesBusy) {
      onError("Wait for the images to finish saving.");
      return;
    }
    try {
      persist();
      onClose();
    } catch (reason) {
      onError(reason);
    }
  };
  const change = async <K extends keyof IssueDraft>(
    key: K,
    value: IssueDraft[K],
  ) => {
    setSaving(true);
    try {
      persist();
      if (key === "status") await onMove(issue.id, value as IssueStatus);
      else updateLocalIssue(issue.id, { [key]: value });
      setDraft((previous) => ({ ...previous, [key]: value }));
    } catch (reason) {
      onError(reason);
    } finally {
      setSaving(false);
    }
  };
  return (
    <IssueDialog
      title={`MC-${issue.number} ${issue.title}`}
      onClose={saveAndClose}
      wide
    >
      <header className="it-detail-header">
        <button
          className="it-icon-button"
          onClick={saveAndClose}
          aria-label="Back to issues"
        >
          <ArrowLeft className="it-icon" />
        </button>
        <span className="it-teal">
          <Folder className="it-icon" />
        </span>
        <span>Issues</span>
        <ChevronRight className="it-icon" />
        <span className="it-muted">MC-{issue.number}</span>
        <button
          className="it-icon-button it-push"
          aria-label="Copy issue as prompt"
          title="Copy as prompt"
          onClick={() => {
            try {
              void copyText(localIssuePrompt(persist())).catch(onError);
            } catch (reason) {
              onError(reason);
            }
          }}
        >
          <Copy className="it-icon" />
        </button>
        <button
          className="it-icon-button"
          aria-label="Close issue"
          onClick={saveAndClose}
        >
          <X className="it-icon" />
        </button>
      </header>
      {detailError ? (
        <div className="it-error-banner" role="alert">
          {detailError}
          <button
            className="it-icon-button"
            aria-label="Dismiss detail error"
            onClick={() => setDetailError("")}
          >
            <X className="it-icon" />
          </button>
        </div>
      ) : null}
      <div className="it-detail-layout">
        <div className="it-detail-content" data-session-drop>
          <textarea
            rows={2}
            className="it-detail-title"
            aria-label="Issue title"
            value={draft.title}
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                title: event.target.value,
              }))
            }
            onBlur={() => {
              try {
                persist();
              } catch (reason) {
                onError(reason);
              }
            }}
          />
          {editingDescription ? (
            <textarea
              autoFocus
              className="it-detail-description"
              aria-label="Issue description"
              placeholder="Add description…"
              value={draft.description}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  description: event.target.value,
                }))
              }
              onBlur={() => {
                try {
                  persist();
                  setEditingDescription(false);
                } catch (reason) {
                  onError(reason);
                }
              }}
            />
          ) : (
            <div
              className="it-description-preview"
              onDoubleClick={() => setEditingDescription(true)}
            >
              <button
                className="it-icon-button it-edit-description"
                aria-label="Edit issue description"
                title="Edit description"
                onClick={() => setEditingDescription(true)}
              >
                <Pencil className="it-icon" />
              </button>
              {draft.description ? (
                <AgentMarkdown text={draft.description} />
              ) : (
                <button
                  className="it-muted"
                  onClick={() => setEditingDescription(true)}
                >
                  Add description…
                </button>
              )}
            </div>
          )}
          <IssueImages
            images={draft.images}
            disabled={running || saving}
            onBusy={setImagesBusy}
            onChange={(images) => {
              try {
                updateLocalIssue(issue.id, { images });
                setDraft((previous) => ({ ...previous, images }));
              } catch (reason) {
                onError(reason);
              }
            }}
            onError={onError}
          />
          <div className="it-activity">
            {issue.reviews?.length ||
            (issue.status === "in_review" &&
              blocks.some((block) => block.role === "assistant")) ? (
              <section className="it-review">
                <h3>Review</h3>
                <IssueOutput
                  cwd={issue.projectPath}
                  images={issue.reviews?.slice(-1)[0]?.images}
                  evidenceError={issue.reviews?.slice(-1)[0]?.evidenceError}
                  text={
                    issue.reviews?.slice(-1)[0]?.text ||
                    blocks
                      .filter((block) => block.role === "assistant")
                      .slice(-1)[0]?.text ||
                    ""
                  }
                />
                {(issue.reviews?.length ?? 0) > 1 ? (
                  <details>
                    <summary>Previous reviews</summary>
                    {issue.reviews!.slice(0, -1).map((review) => (
                      <details key={review.id}>
                        <summary>
                          {new Date(review.at).toLocaleString()} ·{" "}
                          {review.kind === "commit" ? "Commit" : "Review"}
                        </summary>
                        <IssueOutput
                          cwd={issue.projectPath}
                          text={review.text}
                          images={review.images}
                          evidenceError={review.evidenceError}
                        />
                      </details>
                    ))}
                  </details>
                ) : null}
                {issue.status === "in_review" ? (
                  <button
                    className="it-primary"
                    disabled={running || saving}
                    onClick={() => {
                      try {
                        persist();
                        void onContinue(issue.id, undefined, "commit").catch(
                          onError,
                        );
                      } catch (reason) {
                        onError(reason);
                      }
                    }}
                  >
                    Approve and commit
                  </button>
                ) : null}
              </section>
            ) : null}
            <details className="it-history">
              <summary>Activity · {issue.activity.length} events</summary>
              {issue.activity.map((entry) => (
                <div className="it-activity-row" key={entry.id}>
                  <span className="it-activity-dot" />
                  <p>
                    {entry.text}
                    <time title={entry.at}>
                      {new Date(entry.at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </p>
                </div>
              ))}
              {issue.reviews?.map((review) => (
                <details key={review.id}>
                  <summary>
                    {review.kind === "commit"
                      ? "Commit result"
                      : "Agent review and evidence"}{" "}
                    · {new Date(review.at).toLocaleString()}
                  </summary>
                  <IssueOutput
                    cwd={issue.projectPath}
                    text={review.text}
                    images={review.images}
                    evidenceError={review.evidenceError}
                  />
                </details>
              ))}
            </details>
            {issue.sessionId ? (
              <details className="it-transcript" open={running}>
                <summary>
                  Agent transcript · {blocks.length} entries{" "}
                  {running ? "· working" : ""}
                </summary>
                <div
                  className="it-thread"
                  onContextMenuCapture={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <AgentTranscript
                    historicalBlockIds={historicalBlockIds}
                    blocks={blocks
                      .filter((block) => !block.draft)
                      .map((block) =>
                        block.streaming
                          ? { ...block, streaming: false }
                          : block,
                      )}
                    cwd={issue.projectPath}
                    harness={issue.agent || undefined}
                    model={issue.model}
                    modelSettings={issue.modelSettings}
                    busy={running}
                    managed
                    hideTurnMetrics
                    onApproval={
                      onApproval
                        ? (requestId, decision) =>
                            onApproval(issue.sessionId!, requestId, decision)
                        : undefined
                    }
                  />
                </div>
              </details>
            ) : null}
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (!comment.trim()) return;
                try {
                  persist();
                  if (issue.status === "in_review")
                    await onContinue(issue.id, comment.trim());
                  else updateLocalIssue(issue.id, {}, comment.trim());
                  setComment("");
                } catch (reason) {
                  onError(reason);
                }
              }}
            >
              <textarea
                aria-label="Add issue detail"
                placeholder="Leave a comment or add supporting details…"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
              <button
                className="it-chip"
                disabled={!comment.trim() || running}
                type="submit"
              >
                {issue.status === "in_review"
                  ? "Send feedback and iterate"
                  : "Add comment"}
              </button>
            </form>
          </div>
        </div>
        <aside className="it-detail-properties">
          <h3>Properties</h3>
          <IssueProperties
            draft={{
              ...draft,
              status: issue.status,
              agent: issue.agent,
              projectPath: issue.projectPath,
              priority: issue.priority,
            }}
            projects={projects}
            onChange={(key, value) => {
              void change(key, value);
            }}
            disabled={running || saving || imagesBusy}
          />
          <h3>Labels</h3>
          <input
            className="it-label-input"
            aria-label="Issue labels"
            placeholder="Add labels…"
            value={draft.labels.join(",")}
            onChange={(event) =>
              setDraft((previous) => ({
                ...previous,
                labels: event.target.value.split(","),
              }))
            }
            onBlur={() => {
              try {
                persist();
              } catch (reason) {
                onError(reason);
              }
            }}
          />
          <h3>Agent workflow</h3>
          <p className="it-workflow-help">
            Move Backlog → To Do to assign the issue and start a dedicated
            thread with the title, description, and attached images.
          </p>
          {issue.sessionId ? (
            <button
              className="it-thread-link"
              onClick={() => {
                onClose();
                void Promise.resolve(onOpenSession?.(issue.sessionId!)).catch(
                  onError,
                );
              }}
            >
              <Bot className="it-icon" />
              Open agent thread
              <ChevronRight className="it-icon" />
            </button>
          ) : null}
          {issue.runState ? (
            <p
              className={`it-run-state ${issue.runState === "failed" ? "it-error" : ""}`}
            >
              {running ? (
                <LoaderCircle className="it-icon animate-spin" />
              ) : (
                <Bot className="it-icon" />
              )}
              {issue.runState === "completed"
                ? issue.status === "done"
                  ? "Approved and committed"
                  : "Ready for review"
                : issue.runState === "failed"
                  ? "Agent needs attention"
                  : issue.runState === "cancelled"
                    ? "Agent stopped"
                    : issue.runState === "starting"
                      ? "Starting agent…"
                      : "Agent is working"}
            </p>
          ) : null}
          {issue.runError ? (
            <p role="alert" className="it-error">
              {issue.runError}
            </p>
          ) : null}
          {issue.runState === "failed" || issue.runState === "cancelled" ? (
            <button
              className="it-chip"
              disabled={saving}
              onClick={() => {
                try {
                  persist();
                  void onRetry(issue.id).catch(onError);
                } catch (reason) {
                  onError(reason);
                }
              }}
            >
              Retry agent
            </button>
          ) : null}
          <div className="it-detail-dates">
            <p>Created {new Date(issue.createdAt).toLocaleDateString()}</p>
            <p>Updated {new Date(issue.updatedAt).toLocaleDateString()}</p>
          </div>
          <button
            className="it-archive-button"
            disabled={running || imagesBusy}
            onClick={() => {
              try {
                persist();
                updateLocalIssue(
                  issue.id,
                  { archived: !issue.archived },
                  issue.archived ? "Restored the issue" : "Archived the issue",
                );
                onClose();
              } catch (reason) {
                onError(reason);
              }
            }}
          >
            <Archive className="it-icon" />
            {issue.archived ? "Restore issue" : "Archive issue"}
          </button>
        </aside>
      </div>
    </IssueDialog>
  );
}

export function IssueTracker({
  cwd,
  recents,
  onLaunch,
  onOpenSession,
  onReadSession,
  onApproval,
}: Props) {
  const [issues, setIssues] = useState<LocalIssue[]>([]);
  const [error, setError] = useState("");
  const [storeError, setStoreError] = useState(false);
  const [view, setView] = useState<View>("issues");
  const [scope, setScope] = useState<Scope>("all");
  const [layout, setLayout] = useState<"board" | "list">(() => {
    try {
      return localStorage.getItem("monocode.issues.layout") === "list"
        ? "list"
        : "board";
    } catch {
      return "board";
    }
  });
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [showEmpty, setShowEmpty] = useState(false);
  const [hidden, setHidden] = useState<IssueStatus[]>([]);
  const [favorite, setFavorite] = useState(false);
  const [createStatus, setCreateStatus] = useState<IssueStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [context, setContext] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const search = useRef<HTMLInputElement>(null);
  const projects = useMemo(
    () => [
      ...new Set(
        [
          ...[...collectRailProjects(recents, cwd).values()].map(
            (item) => item.path,
          ),
          ...issues.map((issue) => issue.projectPath),
        ].filter((path) => path && path !== "~"),
      ),
    ],
    [recents, cwd, issues],
  );
  const showError = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : String(reason));
  useEffect(() => {
    const refresh = () => {
      try {
        setIssues(loadLocalIssues());
        setStoreError(false);
      } catch (reason) {
        setStoreError(true);
        showError(reason);
      }
    };
    refresh();
    return subscribeLocalIssues(refresh);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        document.querySelector("[role=dialog]") ||
        (event.target instanceof Element &&
          event.target.closest(
            "input, textarea, [contenteditable=true], [role=menu]",
          ))
      )
        return;
      if (
        event.key.toLowerCase() === "c" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setCreateStatus("backlog");
      }
      if (event.key === "/") {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope]);

  const navigate = (next: View) => {
    setView(next);
    setSelectedId(null);
    setQuery("");
    setFilter("");
    setScope("all");
  };
  const move = async (id: string, status: IssueStatus) => {
    const issue = issues.find((entry) => entry.id === id);
    if (status === "done" && issue?.status === "in_review" && issue.sessionId) {
      await continueIssue(id, undefined, "commit");
      return;
    }
    await moveLocalIssue(id, status, onLaunch);
  };
  const continueIssue = async (
    id: string,
    feedback?: string,
    kind: "work" | "commit" = "work",
  ) => {
    if (!onLaunch) throw new Error("Agent dispatch is unavailable.");
    await startLocalIssue(id, onLaunch, { feedback, kind });
  };
  const retry = async (id: string) => {
    if (!onLaunch) throw new Error("Agent dispatch is unavailable.");
    const issue = issues.find((entry) => entry.id === id);
    await startLocalIssue(
      id,
      onLaunch,
      issue?.runKind === "commit"
        ? { kind: "commit" }
        : issue?.feedback
          ? { feedback: issue.feedback }
          : undefined,
    );
  };
  const create = async (draft: IssueDraft) => {
    // Always save first in Backlog, so direct creation in To Do uses the same dispatch path.
    const issue = createLocalIssue({
      ...draft,
      status: draft.status === "todo" ? "backlog" : draft.status,
    });
    setNotice(`Created MC-${issue.number}`);
    if (draft.status === "todo") {
      await move(issue.id, "todo").catch(showError);
    }
  };
  const visible = issues
    .filter((issue) => {
      if (Boolean(issue.archived) !== (view === "archive")) return false;
      if (project && !sameProjectPath(issue.projectPath, project)) return false;
      if (
        view !== "archive" &&
        scope === "backlog" &&
        issue.status !== "backlog"
      )
        return false;
      if (
        view !== "archive" &&
        scope === "active" &&
        !["todo", "in_progress", "in_review"].includes(issue.status)
      )
        return false;
      if (filter && issue.status !== filter) return false;
      return `${issue.title} MC-${issue.number} ${issue.description} ${issue.labels.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase());
    })
    .sort((a, b) =>
      sort === "priority"
        ? (a.priority || 5) - (b.priority || 5) || b.number - a.number
        : sort === "oldest"
          ? a.number - b.number
          : b.number - a.number,
    );
  const selected = issues.find((issue) => issue.id === selectedId);
  const statuses = ISSUE_STATUSES.filter(
    (status) => !filter || status === filter,
  ).filter(
    (status) =>
      view === "archive" ||
      scope === "all" ||
      (scope === "backlog"
        ? status === "backlog"
        : ["todo", "in_progress", "in_review"].includes(status)),
  );
  const columns = statuses.filter(
    (status) =>
      !hidden.includes(status) &&
      (showEmpty || visible.some((issue) => issue.status === status)),
  );
  const collapsed = statuses.filter((status) => !columns.includes(status));
  const issueRow = (issue: LocalIssue) => (
    <div
      className={`it-card ${layout === "list" ? "it-list-row" : ""}`}
      key={issue.id}
      onContextMenu={(event) => {
        event.preventDefault();
        setContext({ id: issue.id, x: event.clientX, y: event.clientY });
      }}
      draggable={!issue.archived}
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-monocode-issue", issue.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <button
        className="it-card-open"
        onClick={() => setSelectedId(issue.id)}
        aria-label={`Open MC-${issue.number}: ${issue.title}`}
      >
        <span className="it-card-id">MC-{issue.number}</span>
        <span className="it-card-title">
          <StatusIcon status={issue.status} />
          <span>{issue.title}</span>
        </span>
        <span className="it-card-meta">
          <span className={`it-priority it-priority-${issue.priority}`}>
            {issue.priority ? ISSUE_PRIORITIES[issue.priority] : "···"}
          </span>
          {issue.projectPath ? (
            <span className="it-chip">
              <Folder className="it-icon" />
              {projectName(issue.projectPath)}
            </span>
          ) : null}
          {issue.labels.slice(0, 2).map((label) => (
            <span className="it-label" key={label}>
              {label}
            </span>
          ))}
        </span>
        <span className="it-card-date">
          {issue.runState === "running" || issue.runState === "starting" ? (
            <>
              <LoaderCircle className="it-icon animate-spin" />
              {issue.runState === "starting"
                ? "Starting agent"
                : "Agent is working"}
            </>
          ) : issue.runState === "failed" ? (
            <span className="it-error">Agent needs attention</span>
          ) : (
            `Created ${new Date(issue.createdAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
          )}
        </span>
      </button>
      <Choice
        label={`Change status for MC-${issue.number}`}
        value={issue.status}
        options={STATUS_OPTIONS}
        onChange={(value) => {
          void move(issue.id, value as IssueStatus).catch(showError);
        }}
        className="it-card-action it-icon-button"
        disabled={issue.runState === "starting" || issue.runState === "running"}
      >
        <MoreHorizontal className="it-icon" />
      </Choice>
      <span
        className="it-card-model"
        title={
          issue.model ||
          (issue.agent ? HARNESS_LABEL[issue.agent] : "Project default model")
        }
      >
        <HarnessIcon
          harness={
            issue.agent || defaultSessionChoice(issue.projectPath).harness
          }
          className="it-icon"
        />
      </span>
    </div>
  );
  const dropProps = (status: IssueStatus) => ({
    onDragOver: (event: React.DragEvent) => {
      if (event.dataTransfer.types.includes("application/x-monocode-issue")) {
        event.preventDefault();
        event.currentTarget.classList.add("it-drop-target");
      }
    },
    onDragLeave: (event: React.DragEvent) => {
      event.currentTarget.classList.remove("it-drop-target");
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.currentTarget.classList.remove("it-drop-target");
      const id = event.dataTransfer.getData("application/x-monocode-issue");
      if (id) void move(id, status).catch(showError);
    },
  });
  const viewTitle = view === "archive" ? "Archived issues" : "Issues";
  return (
    <div
      className="issue-surface issue-tracker"
      data-app-inbox
      data-local-issue-tracker
      onContextMenu={(event) => event.preventDefault()}
    >
      {sidebarOpen ? (
        <aside className="it-sidebar sidebar-glass">
          <nav aria-label="Issue tracker">
            <button
              className={view === "issues" && !project ? "is-active" : ""}
              onClick={() => {
                setProject("");
                navigate("issues");
              }}
            >
              <Inbox className="it-icon" />
              Issues
              <span className="it-push it-muted">
                {issues.filter((issue) => !issue.archived).length}
              </span>
            </button>
            <button
              className={
                view === "issues" && filter === "in_review" ? "is-active" : ""
              }
              onClick={() => {
                navigate("issues");
                setScope("active");
                setFilter("in_review");
              }}
            >
              <CheckCircle className="it-icon" />
              Reviews
            </button>
          </nav>
          <div className="it-sidebar-heading">
            Workspace
            <ChevronDown className="it-icon" />
          </div>
          <nav>
            <button
              onClick={() => {
                setProject("");
                navigate("issues");
                setLayout("board");
              }}
            >
              <DashboardSquare className="it-icon" />
              Kanban
            </button>
            <button
              onClick={() => {
                navigate("issues");
                setLayout("list");
              }}
            >
              <ListBullet className="it-icon" />
              All issues
            </button>
            <button
              className={view === "archive" ? "is-active" : ""}
              onClick={() => navigate("archive")}
            >
              <Archive className="it-icon" />
              Archive
            </button>
          </nav>
          <div className="it-sidebar-heading">
            Your projects
            <ChevronDown className="it-icon" />
          </div>
          <nav className="it-project-nav">
            {projects.map((path) => (
              <button
                key={path}
                title={path}
                className={project === path ? "is-active" : ""}
                onClick={() => {
                  setProject(path);
                  navigate("issues");
                }}
              >
                <Folder className="it-icon it-teal" />
                <span>{projectName(path)}</span>
                <span className="it-push it-muted">
                  {
                    issues.filter(
                      (issue) =>
                        !issue.archived &&
                        sameProjectPath(issue.projectPath, path),
                    ).length
                  }
                </span>
              </button>
            ))}
          </nav>
        </aside>
      ) : null}
      <main className="it-main body-glass">
        <header className="it-page-header">
          <button
            className="it-icon-button"
            onClick={() => setSidebarOpen((value) => !value)}
            aria-label="Toggle issue navigation"
          >
            <PanelLeft className="it-icon" />
          </button>
          {project ? (
            <>
              <Folder className="it-icon it-teal" />
              <span>{projectName(project)}</span>
              <ChevronRight className="it-icon it-muted" />
            </>
          ) : null}
          <strong>{viewTitle}</strong>
          <button
            className={`it-icon-button ${favorite ? "it-favorite" : ""}`}
            aria-label="Favorite issue view"
            aria-pressed={favorite}
            onClick={() => setFavorite((value) => !value)}
          >
            <Star className="it-icon" />
          </button>
          <button
            className="it-chip it-push"
            disabled={storeError}
            onClick={() => setCreateStatus("backlog")}
          >
            <Plus className="it-icon" />
            New issue<kbd>C</kbd>
          </button>
        </header>
        <div className="it-toolbar">
          {view !== "archive" ? (
            <div
              className="it-view-tabs"
              role="tablist"
              aria-label="Issue views"
            >
              {(["active", "backlog", "all"] as const).map((value) => (
                <button
                  role="tab"
                  aria-selected={scope === value}
                  className={scope === value ? "is-active" : ""}
                  key={value}
                  onClick={() => setScope(value)}
                >
                  {value === "all"
                    ? "All issues"
                    : value === "active"
                      ? "Active"
                      : "Backlog"}
                </button>
              ))}
            </div>
          ) : (
            <span className="it-muted">Archived issues can be restored</span>
          )}
          <div className="it-toolbar-actions">
            <div
              className="it-layout-toggle"
              role="group"
              aria-label="Issue layout"
            >
              <button
                className="it-icon-button"
                aria-label="Kanban view"
                aria-pressed={layout === "board"}
                onClick={() => {
                  setLayout("board");
                  try {
                    localStorage.setItem("monocode.issues.layout", "board");
                  } catch {}
                }}
              >
                <DashboardSquare className="it-icon" />
              </button>
              <button
                className="it-icon-button"
                aria-label="List view"
                aria-pressed={layout === "list"}
                onClick={() => {
                  setLayout("list");
                  try {
                    localStorage.setItem("monocode.issues.layout", "list");
                  } catch {}
                }}
              >
                <ListBullet className="it-icon" />
              </button>
            </div>
            <label className="it-search">
              <Search className="it-icon" />
              <input
                ref={search}
                placeholder="Search issues…"
                aria-label="Search issues"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  className="it-icon-button"
                  onClick={() => setQuery("")}
                  aria-label="Clear issue search"
                >
                  <X className="it-icon" />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </label>
            <>
              <Choice
                label="Filter issues"
                value={filter}
                options={[
                  { value: "", label: "All statuses" },
                  ...STATUS_OPTIONS,
                ]}
                onChange={setFilter}
                className={`it-round-button ${filter ? "is-selected" : ""}`}
              >
                <ListFilter className="it-icon" />
              </Choice>
              <Choice
                label="Display options"
                value={layout}
                options={[
                  {
                    value: "board",
                    label: "Kanban",
                    icon: <DashboardSquare className="it-icon" />,
                  },
                  {
                    value: "list",
                    label: "List",
                    icon: <ListBullet className="it-icon" />,
                  },
                  {
                    value: "empty",
                    label: showEmpty
                      ? "Hide empty groups"
                      : "Show empty groups",
                  },
                  { value: "newest", label: "Newest first" },
                  { value: "oldest", label: "Oldest first" },
                  { value: "priority", label: "Priority" },
                ]}
                onChange={(value) => {
                  if (value === "board" || value === "list") {
                    setLayout(value);
                    try {
                      localStorage.setItem("monocode.issues.layout", value);
                    } catch {}
                  } else if (value === "empty") setShowEmpty((value) => !value);
                  else setSort(value);
                }}
                className="it-round-button"
              >
                <SlidersHorizontal className="it-icon" />
              </Choice>
            </>
          </div>
        </div>
        {error ? (
          <div className="it-error-banner" role="alert">
            {error}
            <button
              className="it-icon-button"
              aria-label="Dismiss issue error"
              onClick={() => setError("")}
            >
              <X className="it-icon" />
            </button>
          </div>
        ) : null}
        <div className={`it-board ${layout === "list" ? "it-list" : ""}`}>
          {visible.length === 0 ? (
            <div className="it-empty">
              <Inbox className="it-empty-icon" />
              <h2>
                {query || filter
                  ? "No matching issues"
                  : view === "archive"
                    ? "No archived issues"
                    : scope === "active"
                      ? "No active issues"
                      : "Make room for your next idea"}
              </h2>
              <p>
                {query || filter
                  ? "Try a different search or filter."
                  : scope === "active"
                    ? "Move an issue from Backlog to To Do to start an agent."
                    : view === "archive"
                      ? "Archived issues will appear here."
                      : "Create an issue, add the details, and turn it into agent work."}
              </p>
              {view !== "archive" ? (
                <button
                  className="it-primary"
                  disabled={storeError}
                  onClick={() => setCreateStatus("backlog")}
                >
                  <Plus className="it-icon" />
                  Create issue
                </button>
              ) : null}
              {query || filter ? (
                <button
                  className="it-chip"
                  onClick={() => {
                    setQuery("");
                    setFilter("");
                  }}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
          ) : null}
          {columns.map((status) => (
            <section
              className="it-column"
              key={status}
              aria-label={`${ISSUE_STATUS_LABELS[status]} issues`}
              {...dropProps(status)}
            >
              <div className="it-column-header">
                <StatusIcon status={status} />
                <h2>{ISSUE_STATUS_LABELS[status]}</h2>
                <span className="it-muted">
                  {visible.filter((issue) => issue.status === status).length}
                </span>
                <button
                  className="it-icon-button it-push it-column-action"
                  aria-label={`Hide ${ISSUE_STATUS_LABELS[status]} column`}
                  onClick={() => setHidden((previous) => [...previous, status])}
                >
                  <MoreHorizontal className="it-icon" />
                </button>
                <button
                  className="it-icon-button it-column-action"
                  aria-label={`Create issue in ${ISSUE_STATUS_LABELS[status]}`}
                  onClick={() => setCreateStatus(status)}
                >
                  <Plus className="it-icon" />
                </button>
              </div>
              <div className="it-column-items">
                {visible
                  .filter((issue) => issue.status === status)
                  .map(issueRow)}
                <button
                  className="it-add-row"
                  onClick={() => setCreateStatus(status)}
                >
                  <Plus className="it-icon" />
                  Add issue
                </button>
              </div>
            </section>
          ))}
          {collapsed.length && layout === "board" ? (
            <aside className="it-hidden-columns">
              <h3>
                <ChevronDown className="it-icon" />
                Hidden columns
              </h3>
              {collapsed.map((status) => (
                <button
                  key={status}
                  {...dropProps(status)}
                  onClick={() => {
                    setHidden((previous) =>
                      previous.filter((value) => value !== status),
                    );
                    setShowEmpty(true);
                  }}
                >
                  <StatusIcon status={status} />
                  <span>{ISSUE_STATUS_LABELS[status]}</span>
                  <span className="it-push it-muted">
                    {visible.filter((issue) => issue.status === status).length}
                  </span>
                </button>
              ))}
            </aside>
          ) : null}
        </div>
      </main>
      {createStatus ? (
        <NewIssue
          project={project || (cwd !== "~" ? cwd : "")}
          projects={projects}
          status={createStatus}
          onClose={() => setCreateStatus(null)}
          onCreate={create}
        />
      ) : null}
      {selected ? (
        <IssueDetail
          key={selected.id}
          issue={selected}
          projects={projects}
          onClose={() => setSelectedId(null)}
          onMove={move}
          onRetry={retry}
          onContinue={continueIssue}
          onReadSession={onReadSession}
          onApproval={onApproval}
          onOpenSession={onOpenSession}
          onError={showError}
        />
      ) : null}
      {notice ? (
        <div className="it-toast" role="status">
          <CheckCircle className="it-icon" />
          {notice}
        </div>
      ) : null}
      {context ? (
        <Popover
          anchor={context}
          width={248}
          onDismiss={() => setContext(null)}
          autoFocus
          className="issue-surface it-menu"
          role="menu"
          aria-label="Issue actions"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            ];
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            items[
              (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length
            ]?.focus();
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              setSelectedId(context.id);
              setContext(null);
            }}
          >
            <Pencil className="it-icon" />
            Open issue
          </button>
          <Choice
            label="Status"
            value={
              issues.find((issue) => issue.id === context.id)?.status ||
              "backlog"
            }
            options={STATUS_OPTIONS}
            disabled={["starting", "running"].includes(
              issues.find((issue) => issue.id === context.id)?.runState || "",
            )}
            onChange={(value) => {
              void move(context.id, value as IssueStatus).catch(showError);
              setContext(null);
            }}
          >
            <CircleDashed className="it-icon" />
            Change status
            <ChevronRight className="it-icon" />
          </Choice>
          <Choice
            label="Priority"
            value={String(
              issues.find((issue) => issue.id === context.id)?.priority || 0,
            )}
            options={PRIORITY_OPTIONS}
            onChange={(value) => {
              try {
                updateLocalIssue(context.id, { priority: Number(value) });
                setContext(null);
              } catch (reason) {
                showError(reason);
              }
            }}
          >
            <ListFilter className="it-icon" />
            Set priority
            <ChevronRight className="it-icon" />
          </Choice>
          <button
            role="menuitem"
            onClick={() => {
              const issue = issues.find((issue) => issue.id === context.id)!;
              void copyText(localIssuePrompt(issue)).catch(showError);
              setContext(null);
            }}
          >
            <Copy className="it-icon" />
            Copy as prompt
          </button>
          <button
            role="menuitem"
            disabled={["starting", "running"].includes(
              issues.find((issue) => issue.id === context.id)?.runState || "",
            )}
            onClick={() => {
              try {
                const issue = issues.find((issue) => issue.id === context.id)!;
                updateLocalIssue(
                  issue.id,
                  { archived: !issue.archived },
                  issue.archived ? "Restored the issue" : "Archived the issue",
                );
                setContext(null);
              } catch (reason) {
                showError(reason);
              }
            }}
          >
            <Archive className="it-icon" />
            {view === "archive" ? "Restore issue" : "Archive issue"}
          </button>
        </Popover>
      ) : null}
    </div>
  );
}
