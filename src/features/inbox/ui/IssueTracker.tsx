import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IssueImage } from "../model/localIssueImages";
import { AttachmentChip } from "../../sessions/ui/AttachmentChip";
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
  GitPullRequest,
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
  X,
} from "../../../shared/ui/icons";
import { Popover, type PopoverAnchor } from "../../../shared/ui/Popover";
import { copyText } from "../../../platform/tauri/clipboard";
import { suppressTextSelection } from "../../../shared/lib/drag";
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
  type ModelTarget,
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
import { IssueImages, useIssueImages } from "./IssueImages";
import { gitCommitFiles } from "../../../platform/tauri/fs";
import { polishIssue } from "../../settings/model/taskModel";
import {
  createLocalIssue,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  canPeerReview,
  isIssueRunning,
  loadLocalIssues,
  localIssuePrompt,
  moveLocalIssue,
  peerReviewOf,
  startLocalIssue,
  startPeerReview,
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

const SORT_KEY = "monocode.issues.sort";
const SHOW_EMPTY_KEY = "monocode.issues.showEmpty";
const HIDDEN_KEY = "monocode.issues.hiddenColumns";
const readSetting = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeSetting = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

/** CSS owns the exit timing; 0 (reduced motion, tests) unmounts at once. */
function dialogExitMs() {
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--it-dialog-exit")
    .trim();
  const ms = parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}
/** Keeps the last value mounted while its exit animation plays. */
function useExit<T>(value: T | null): [T | null, boolean] {
  const [kept, setKept] = useState(value);
  useEffect(() => {
    if (value != null) {
      setKept(value);
      return;
    }
    const timer = window.setTimeout(() => setKept(null), dialogExitMs());
    return () => window.clearTimeout(timer);
  }, [value]);
  const leaving = value == null && kept != null && dialogExitMs() > 0;
  return [leaving ? kept : value, leaving];
}
/** Next card to focus, or undefined at an edge. Board: arrows stay in a column or hop columns; list: one flat run. */
function stepFocus(
  groups: string[][],
  layout: "board" | "list",
  from: string | undefined,
  dx: number,
  dy: number,
) {
  const flat = groups.flat();
  const at = from ? flat.indexOf(from) : -1;
  if (at < 0) return flat[0];
  if (layout === "list") return dx ? undefined : flat[at + dy];
  const column = groups.findIndex((group) => group.includes(from!));
  const row = groups[column].indexOf(from!);
  if (dy) return groups[column][row + dy];
  const next = groups[column + dx];
  return next?.[Math.min(row, next.length - 1)];
}

type View = "issues" | "archive";
type Scope = "active" | "backlog" | "all";
type Option = {
  value: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  /** Overrides the single-value selection, for menus that mix several settings. */
  checked?: boolean;
};
const ACTIVE_STATUSES: readonly IssueStatus[] = [
  "todo",
  "in_progress",
  "in_review",
];
type Props = {
  cwd: string;
  recents: RecentProject[];
  onLaunch?: (issue: LocalIssue) => Promise<void>;
  /** Runs another model over the issue's work; resolves with its review text and thread. */
  onReview?: (
    issue: LocalIssue,
    target: ModelTarget,
  ) => Promise<{ text: string; sessionId: string }>;
  /** Shows a GitHub entry in the navigation when provided. */
  onOpenGithub?: () => void;
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
// In Progress is owned by the agent, so a new issue cannot start there.
const CREATE_STATUS_OPTIONS = STATUS_OPTIONS.filter(
  (option) => option.value !== "in_progress",
);
const PRIORITY_OPTIONS: Option[] = ISSUE_PRIORITIES.map((label, value) => ({
  value: String(value),
  label,
  hint: String(value),
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
  const [error, setError] = useState("");
  const files = useIssueImages(images, (reason) => setError(String(reason)));
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
  const pick = (option: Option) => {
    onChange(option.value);
    setAnchor(null);
    anchor?.focus();
  };
  // Number hints are shortcuts, so the digit must not reach the search box.
  const hotkey = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const option = options.find((entry) => entry.hint === event.key);
    if (!option) return;
    event.preventDefault();
    pick(option);
  };
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
              hotkey(event);
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
              hotkey(event);
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
            {choices.map((option) => {
              const selected = option.checked ?? value === option.value;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  key={option.value}
                  onClick={() => pick(option)}
                >
                  {option.icon}
                  <span>{option.label}</span>
                  {selected ? (
                    <Check className="it-icon" />
                  ) : option.hint ? (
                    <kbd>{option.hint}</kbd>
                  ) : null}
                </button>
              );
            })}
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
  leaving = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Plays the exit animation; the parent unmounts once it has finished. */
  leaving?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  const exiting = useRef(leaving);
  exiting.current = leaving;
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
        exiting.current ||
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
      className={`it-dialog-backdrop ${wide ? "it-dialog-backdrop-wide" : ""} ${leaving ? "is-leaving" : ""}`}
      inert={leaving}
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

/** Short commit id; commit details load on first hover, never per card render. */
function CommitChip({ issue }: { issue: LocalIssue }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<string[] | null>(null);
  const requested = useRef(false);
  const meta = issue.commitMeta;
  const show = () => {
    setOpen(true);
    if (requested.current) return;
    requested.current = true;
    gitCommitFiles(issue.projectPath, issue.commitSha!).then(
      (changed) => setFiles(changed.map((file) => file.relative)),
      () => setFiles([]),
    );
  };
  return (
    <span
      ref={ref}
      className="it-sha"
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
      onFocus={show}
      onBlur={() => setOpen(false)}
      aria-label={`Commit ${issue.commitSha}`}
    >
      #{issue.commitSha!.slice(0, 7)}
      {open ? (
        <Popover
          bare
          anchor={ref}
          side="bottom"
          align="start"
          width={300}
          className="issue-surface it-menu it-sha-pop"
        >
          <strong>{meta?.subject || issue.commitSha}</strong>
          {meta?.author ? (
            <span>
              {meta.author} · {new Date(meta.at).toLocaleString()}
            </span>
          ) : null}
          <span>
            {files === null
              ? "Loading files…"
              : files.length
                ? `${files.length} file${files.length === 1 ? "" : "s"} changed`
                : "No file list available"}
          </span>
          {files?.slice(0, 8).map((file) => (
            <code key={file}>{file}</code>
          ))}
          {files && files.length > 8 ? (
            <span>+{files.length - 8} more</span>
          ) : null}
        </Popover>
      ) : null}
    </span>
  );
}

function NewIssue({
  project,
  projects,
  status,
  onClose,
  onCreate,
  leaving,
}: {
  project: string;
  projects: string[];
  status: IssueStatus;
  onClose: () => void;
  onCreate: (draft: IssueDraft) => Promise<void>;
  leaving?: boolean;
}) {
  const [draft, setDraft] = useState<IssueDraft>(() => {
    const choice = defaultSessionChoice(project);
    return {
      title: "",
      description: "",
      status: status === "in_progress" ? "todo" : status,
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
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (!busy) descriptionRef.current?.focus();
  }, [busy]);
  const change = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const dismiss = () => {
    if (submitting.current) return;
    if (imagesBusy) setError("Wait for the images to finish saving.");
    else onClose();
  };
  const submit = async () => {
    if (submitting.current || imagesBusy || !draft.description.trim()) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const polished = await polishIssue(draft.description);
      // The model's priority only fills in what the user left unset.
      await onCreate({
        ...draft,
        title: polished.title,
        description: polished.description,
        priority: draft.priority || polished.priority,
      });
      if (more) {
        setDraft((previous) => ({
          ...previous,
          title: "",
          description: "",
          images: [],
        }));
      } else onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <IssueDialog title="Create issue" onClose={dismiss} leaving={leaving}>
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
            disabled={busy}
            onClick={dismiss}
          >
            <X className="it-icon" />
          </button>
        </header>
        <fieldset className="it-create-fields" disabled={busy}>
          <textarea
            autoFocus
            ref={descriptionRef}
            className="it-description"
            placeholder="Describe the issue…"
            aria-label="Issue description"
            value={draft.description}
            onChange={(event) => change("description", event.target.value)}
            required
          />
          <p className="it-muted">
            Your task model generates a title and polishes this description on
            creation. Configure it in Settings → Inbox → Task model.
          </p>
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
            statusOptions={CREATE_STATUS_OPTIONS}
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
        </fieldset>
        <footer className="it-create-footer">
          <span className="it-muted">Saved on this device</span>
          <label className="it-create-more">
            <span className="it-create-more-control">
              <input
                type="checkbox"
                role="switch"
                checked={more}
                disabled={busy}
                onChange={(event) => setMore(event.target.checked)}
              />
              <span className="it-create-more-track" aria-hidden="true" />
            </span>
            <span>Create more</span>
          </label>
          <button
            className="it-primary"
            type="submit"
            disabled={busy || imagesBusy || !draft.description.trim()}
          >
            {busy ? <LoaderCircle className="it-icon animate-spin" /> : null}
            {busy ? "Polishing issue…" : "Create issue"}
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
  agentLocked = false,
  statusOptions = STATUS_OPTIONS,
}: {
  draft: IssueDraft;
  projects: string[];
  onChange: <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) => void;
  disabled?: boolean;
  /** The issue's thread belongs to one agent; only its models can change. */
  agentLocked?: boolean;
  statusOptions?: Option[];
}) {
  const choice = defaultSessionChoice(draft.projectPath);
  const harness = draft.agent || choice.harness;
  const model =
    draft.model || (draft.agent ? preferredModelId(harness) : choice.model);
  const values =
    draft.modelSettings || preferredModelSettings(resolveModel(harness, model));
  const lockHint = `This issue's thread uses ${HARNESS_LABEL[harness]}. Archive and recreate to switch agents.`;
  return (
    <div className="it-properties">
      <Choice
        label="Change status"
        value={draft.status}
        options={statusOptions}
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
        data-agent-locked={agentLocked || undefined}
        title={agentLocked ? lockHint : undefined}
      >
        <ModelPicker
          variant="plain"
          harness={harness}
          model={model}
          values={values}
          project={draft.projectPath}
          side="bottom"
          hotkeys={false}
          allowedHarnesses={agentLocked ? [harness] : undefined}
          onChange={(agent, selectedModel) => {
            if (agentLocked && agent !== harness) return;
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

/** Pick any model through the normal selector, then start a read-only peer review. */
function ReviewPopover({
  issue,
  anchor,
  onStart,
  onDismiss,
}: {
  issue: LocalIssue;
  anchor: PopoverAnchor;
  onStart: (target: ModelTarget) => void;
  onDismiss: () => void;
}) {
  const [choice, setChoice] = useState(() => {
    const { harness, model } = defaultSessionChoice(issue.projectPath);
    return {
      harness,
      model,
      values: preferredModelSettings(resolveModel(harness, model)),
    };
  });
  return (
    <Popover
      anchor={anchor}
      width={260}
      autoFocus
      onDismiss={onDismiss}
      ignore="[data-model-picker]"
      className="issue-surface it-menu it-review-picker"
      role="dialog"
      aria-label={`Review MC-${issue.number} with another model`}
      data-dialog-popover
    >
      <p className="it-muted">Review MC-{issue.number} with</p>
      <ModelPicker
        variant="plain"
        harness={choice.harness}
        model={choice.model}
        values={choice.values}
        project={issue.projectPath}
        side="bottom"
        hotkeys={false}
        onChange={(harness, model) =>
          setChoice({
            harness,
            model,
            values: preferredModelSettings(resolveModel(harness, model)),
          })
        }
        onSettingsChange={(values) =>
          setChoice((previous) => ({ ...previous, values }))
        }
      />
      <button
        className="it-primary"
        onClick={() =>
          onStart({
            harness: choice.harness,
            model: choice.model,
            modelSettings: choice.values,
          })
        }
      >
        Start review
      </button>
    </Popover>
  );
}

function IssueDetail({
  issue,
  projects,
  onClose,
  onMove,
  onRetry,
  onContinue,
  onReview,
  onReadSession,
  onApproval,
  onOpenSession,
  onError: reportGlobalError,
  leaving,
}: {
  leaving?: boolean;
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
  onReview: (id: string, target: ModelTarget) => void;
  onReadSession?: Props["onReadSession"];
  onApproval?: Props["onApproval"];
  onOpenSession?: Props["onOpenSession"];
  onError: (reason: unknown) => void;
}) {
  const [draft, setDraft] = useState<IssueDraft>(issue);
  const [moreMenu, setMoreMenu] = useState<HTMLElement | null>(null);
  const [picking, setPicking] = useState(false);
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
  const running = isIssueRunning(issue);
  // The latest work review stays primary; commit output is shown beside it, never instead of it.
  const newestReviews = [...(issue.reviews ?? [])].reverse();
  const workReview = newestReviews.find((review) => review.kind === "work");
  const commitReview = newestReviews.find((review) => review.kind === "commit");
  const peerReviews = newestReviews.filter((review) => review.kind === "peer");
  const peerState = peerReviewOf(issue.id);
  const previousReviews = newestReviews.filter(
    (review) =>
      review !== workReview &&
      review !== commitReview &&
      review.kind !== "peer",
  );
  const committing = issue.runKind === "commit";
  const commitStatus = committing
    ? running
      ? "Committing…"
      : issue.runState === "completed"
        ? "Committed"
        : issue.runState === "cancelled"
          ? "Commit stopped; back in review"
          : issue.runState === "failed"
            ? `Not committed${issue.runError ? `: ${issue.runError}` : ""}`
            : ""
    : commitReview
      ? "Earlier commit result"
      : "";
  const [historyOpen, setHistoryOpen] = useState(running);
  useEffect(() => {
    if (running) setHistoryOpen(true);
  }, [running]);
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
      leaving={leaving}
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
        {issue.commitSha ? <CommitChip issue={issue} /> : null}
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
        {canPeerReview(issue) ? (
          <button
            className="it-icon-button"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={!!moreMenu}
            onClick={(event) => {
              setPicking(false);
              setMoreMenu(event.currentTarget);
            }}
          >
            <MoreHorizontal className="it-icon" />
          </button>
        ) : null}
        <button
          className="it-icon-button"
          aria-label="Close issue"
          onClick={saveAndClose}
        >
          <X className="it-icon" />
        </button>
      </header>
      {moreMenu && !picking ? (
        <Popover
          anchor={moreMenu}
          align="end"
          width={220}
          onDismiss={() => setMoreMenu(null)}
          autoFocus
          className="issue-surface it-menu"
          role="menu"
          aria-label="More actions"
          data-dialog-popover
        >
          <button
            role="menuitem"
            disabled={peerState?.state === "running"}
            onClick={() => setPicking(true)}
          >
            <Bot className="it-icon" />
            Review with…
          </button>
        </Popover>
      ) : null}
      {moreMenu && picking ? (
        <ReviewPopover
          issue={issue}
          anchor={moreMenu}
          onDismiss={() => setMoreMenu(null)}
          onStart={(target) => {
            setMoreMenu(null);
            onReview(issue.id, target);
          }}
        />
      ) : null}
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
                  images={workReview?.images}
                  evidenceError={workReview?.evidenceError}
                  text={
                    workReview?.text ||
                    blocks
                      .filter((block) => block.role === "assistant")
                      .slice(-1)[0]?.text ||
                    ""
                  }
                />
                {commitStatus ? (
                  <div className="it-commit">
                    <h4>Commit</h4>
                    <p
                      className={
                        issue.runKind === "commit" &&
                        (issue.runState === "failed" ||
                          issue.runState === "cancelled")
                          ? "it-error"
                          : "it-muted"
                      }
                    >
                      {commitStatus}
                    </p>
                    {commitReview ? (
                      <IssueOutput
                        cwd={issue.projectPath}
                        text={commitReview.text}
                        images={commitReview.images}
                        evidenceError={commitReview.evidenceError}
                      />
                    ) : null}
                  </div>
                ) : null}
                {peerState ? (
                  <p
                    className={
                      peerState.state === "failed" ? "it-error" : "it-muted"
                    }
                  >
                    {peerState.state === "running"
                      ? `Reviewing with ${peerState.model}…`
                      : `Review with ${peerState.model} failed${peerState.error ? `: ${peerState.error}` : ""}`}
                  </p>
                ) : null}
                {peerReviews.map((review) => (
                  <div className="it-commit" key={review.id}>
                    <h4>Review · {review.model ?? "another model"}</h4>
                    <IssueOutput cwd={issue.projectPath} text={review.text} />
                    {review.sessionId ? (
                      <button
                        className="it-thread-link"
                        onClick={() => {
                          onClose();
                          void Promise.resolve(
                            onOpenSession?.(review.sessionId!),
                          ).catch(onError);
                        }}
                      >
                        <Bot className="it-icon" />
                        Open review thread
                        <ChevronRight className="it-icon" />
                      </button>
                    ) : null}
                  </div>
                ))}
                {previousReviews.length ? (
                  <details>
                    <summary>Previous reviews</summary>
                    {previousReviews.map((review) => (
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
                {issue.status === "in_review" && issue.sessionId && !running ? (
                  <button
                    className="it-primary"
                    disabled={saving}
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
            <details
              className="it-history"
              open={historyOpen}
              onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
            >
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
              {issue.reviews
                ?.filter((review) => review.kind !== "peer")
                .map((review) => (
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
            </details>
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
            agentLocked={!!issue.sessionId}
          />
          {issue.sessionId ? (
            <p className="it-workflow-help" data-testid="agent-locked-hint">
              This issue's thread uses{" "}
              {
                HARNESS_LABEL[
                  issue.agent || defaultSessionChoice(issue.projectPath).harness
                ]
              }
              . Archive and recreate to switch agents.
            </p>
          ) : null}
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
            Move an issue to To Do to start (or resume) its dedicated thread
            with the title, description, and attached images. Approving a review
            marks it Done and commits in the same thread.
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
                  ? committing
                    ? "Commit needs attention"
                    : "Agent needs attention"
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
  onReview,
  onOpenGithub,
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
  const [sort, setSort] = useState(() => {
    const saved = readSetting(SORT_KEY);
    return saved === "oldest" || saved === "priority" ? saved : "newest";
  });
  // Cards are dragged with pointer events: Tauri's native drag-drop handler
  // swallows HTML5 dragover/drop in the webview (see startDrag).
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [dropStatus, setDropStatus] = useState<IssueStatus | null>(null);
  const skipClickUntil = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<string | undefined>(undefined);
  const pendingFocus = useRef<string | undefined>(undefined);
  const prioritySince = useRef(0);
  const [showEmpty, setShowEmpty] = useState(
    () => readSetting(SHOW_EMPTY_KEY) === "1",
  );
  const [hidden, setHidden] = useState<IssueStatus[]>(() => {
    try {
      const saved: unknown = JSON.parse(readSetting(HIDDEN_KEY) ?? "[]");
      return ISSUE_STATUSES.filter(
        (status) => Array.isArray(saved) && saved.includes(status),
      );
    } catch {
      return [];
    }
  });
  const [navOpen, setNavOpen] = useState({ workspace: true, projects: true });
  useEffect(() => writeSetting(SORT_KEY, sort), [sort]);
  useEffect(
    () => writeSetting(SHOW_EMPTY_KEY, showEmpty ? "1" : "0"),
    [showEmpty],
  );
  useEffect(() => writeSetting(HIDDEN_KEY, JSON.stringify(hidden)), [hidden]);
  const [createStatus, setCreateStatus] = useState<IssueStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [context, setContext] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [reviewAt, setReviewAt] = useState<{
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
  // Window listeners outlive renders, so they read the latest closures here.
  const live = useRef({
    key: (_event: KeyboardEvent) => {},
    issues: [] as LocalIssue[],
    move: (async () => {}) as (
      id: string,
      status: IssueStatus,
    ) => Promise<void>,
    showError: (_reason: unknown) => {},
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => live.current.key(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [detail, detailLeaving] = useExit(selectedId);
  const [createShown, createLeaving] = useExit(createStatus);
  // Closing a dialog hands focus back to the card that was last in use.
  const detailOpen = useRef(false);
  useEffect(() => {
    if (detail) {
      detailOpen.current = true;
      return;
    }
    if (!detailOpen.current) return;
    detailOpen.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) focusCard(lastFocus.current);
  }, [detail]);
  // A moved card remounts in its new column; put focus back on it.
  useEffect(() => {
    if (pendingFocus.current && focusCard(pendingFocus.current))
      pendingFocus.current = undefined;
  });

  const navigate = (next: View) => {
    setView(next);
    setSelectedId(null);
    setChecked([]);
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
  const reviewIssue = (id: string, target: ModelTarget) => {
    if (!onReview) return showError("Review is unavailable.");
    // Failures are reported on the issue itself; only a refused start throws here.
    void startPeerReview(
      id,
      resolveModel(target.harness, target.model).name,
      (issue) => onReview(issue, target),
    ).catch(showError);
  };
  const create = async (draft: IssueDraft) => {
    // Always save first in Backlog, so direct creation in To Do uses the same dispatch path.
    // In Progress is agent-owned, so creating there means dispatching too.
    const dispatch = draft.status === "todo" || draft.status === "in_progress";
    const issue = createLocalIssue({
      ...draft,
      status: dispatch ? "backlog" : draft.status,
    });
    setNotice(`Created MC-${issue.number}`);
    if (dispatch) {
      await move(issue.id, "todo").catch(showError);
    }
  };
  const statuses = ISSUE_STATUSES.filter(
    (status) =>
      (!filter || status === filter) &&
      (view === "archive" ||
        scope === "all" ||
        (scope === "backlog"
          ? status === "backlog"
          : ACTIVE_STATUSES.includes(status))),
  );
  const visible = issues
    .filter((issue) => {
      if (Boolean(issue.archived) !== (view === "archive")) return false;
      if (project && !sameProjectPath(issue.projectPath, project)) return false;
      if (!statuses.includes(issue.status)) return false;
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
  const selected = issues.find((issue) => issue.id === detail);
  const columns = statuses.filter(
    (status) =>
      !hidden.includes(status) &&
      // Done is where approved work lands, so it never disappears when empty.
      (showEmpty ||
        (status === "done" && view === "issues") ||
        visible.some((issue) => issue.status === status)),
  );
  const collapsed = statuses.filter((status) => !columns.includes(status));
  // Visual order (column by column), so shift-click ranges match what's on screen.
  const ordered = columns.flatMap((status) =>
    visible.filter((issue) => issue.status === status),
  );
  const clickIssue = (event: React.MouseEvent, id: string) => {
    // The click that ends a drag must not open the card it started on.
    if (performance.now() < skipClickUntil.current) return;
    lastFocus.current = id;
    if (event.shiftKey && anchor.current) {
      const ids = ordered.map((issue) => issue.id);
      const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(id)];
      if (a >= 0 && b >= 0) {
        setChecked(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      anchor.current = id;
      setChecked((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
      return;
    }
    setChecked([]);
    anchor.current = id;
    setSelectedId(id);
  };
  // Right-clicking inside a multi-selection acts on all of it.
  const targets =
    context && checked.length > 1 && checked.includes(context.id)
      ? checked
      : context
        ? [context.id]
        : [];
  const cardOf = (id?: string) =>
    id
      ? [
          ...(rootRef.current?.querySelectorAll<HTMLElement>(
            "[data-issue-id]",
          ) ?? []),
        ].find((card) => card.dataset.issueId === id)
      : undefined;
  const focusCard = (id?: string) => {
    const open = cardOf(id)?.querySelector<HTMLElement>(".it-card-open");
    if (!open) return false;
    open.focus();
    open.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return true;
  };
  const groups = columns
    .map((status) =>
      visible.filter((issue) => issue.status === status).map(({ id }) => id),
    )
    .filter((group) => group.length);
  live.current.issues = issues;
  live.current.move = move;
  live.current.showError = showError;
  live.current.key = (event) => {
    const root = rootRef.current;
    const target = event.target;
    if (
      event.defaultPrevented ||
      !root ||
      root.closest('[aria-hidden="true"]') ||
      // The tracker stays mounted while its tab is hidden; keys elsewhere are not ours.
      (target instanceof Node &&
        target !== document.body &&
        target !== document.documentElement &&
        !root.contains(target)) ||
      document.querySelector("[role=dialog]") ||
      (target instanceof Element &&
        target.closest("input, textarea, [contenteditable=true], [role=menu]"))
    )
      return;
    if (event.key === "Escape") {
      prioritySince.current = 0;
      setChecked([]);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    // `p` arms the priority chord: the next digit (0-4) sets it.
    const chord = Date.now() - prioritySince.current < 1500;
    prioritySince.current = 0;
    if (key === "c") {
      event.preventDefault();
      setCreateStatus("backlog");
      return;
    }
    if (key === "/") {
      event.preventDefault();
      search.current?.focus();
      return;
    }
    const idle =
      !(target instanceof Element) ||
      target === document.body ||
      target === document.documentElement;
    if (!idle && !(target as Element).closest(".it-board")) return;
    const flat = groups.flat();
    const focused =
      target instanceof Element
        ? target.closest<HTMLElement>("[data-issue-id]")?.dataset.issueId
        : undefined;
    const current = [focused, idle ? lastFocus.current : undefined].find(
      (id) => id && flat.includes(id),
    );
    const step = {
      arrowdown: [0, 1],
      j: [0, 1],
      arrowup: [0, -1],
      k: [0, -1],
      arrowright: [1, 0],
      l: [1, 0],
      arrowleft: [-1, 0],
      h: [-1, 0],
    }[key];
    if (step) {
      event.preventDefault();
      const next = stepFocus(groups, layout, current, step[0], step[1]);
      if (!next || !focusCard(next)) return;
      lastFocus.current = next;
      if (event.shiftKey && current)
        setChecked((previous) => [...new Set([...previous, current, next])]);
      return;
    }
    if (!current) return;
    // Actions apply to the whole selection when the focused card is part of it.
    const ids = checked.includes(current) ? checked : [current];
    if (key === "x" || key === " ") {
      event.preventDefault();
      anchor.current = current;
      setChecked((previous) =>
        previous.includes(current)
          ? previous.filter((id) => id !== current)
          : [...previous, current],
      );
    } else if (key === "e" || (key === "enter" && idle)) {
      event.preventDefault();
      setSelectedId(current);
    } else if (key === "p") {
      event.preventDefault();
      prioritySince.current = Date.now();
    } else if (chord && /^[0-4]$/.test(key)) {
      event.preventDefault();
      try {
        for (const id of ids) updateLocalIssue(id, { priority: Number(key) });
      } catch (reason) {
        showError(reason);
      }
    } else if (!chord && /^[1-5]$/.test(key) && view === "issues") {
      event.preventDefault();
      const status = ISSUE_STATUSES[Number(key) - 1];
      for (const id of ids) {
        const issue = issues.find((entry) => entry.id === id);
        if (!issue || isIssueRunning(issue) || issue.status === status)
          continue;
        pendingFocus.current = current;
        void move(id, status).catch(showError);
      }
    }
  };
  // Tauri's native drag-drop handler (on by default, and needed for file
  // drops elsewhere in the app) intercepts HTML5 dragover/drop inside the
  // webview, so `draggable` cards never reach a drop. Like the sidebar and
  // tabs, drag with pointer events and hit-test columns by coordinates.
  const cancelDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancelDrag.current?.(), []);
  const startDrag = (
    event: React.PointerEvent<HTMLElement>,
    issue: LocalIssue,
  ) => {
    if (
      event.button !== 0 ||
      event.pointerType === "touch" ||
      issue.archived ||
      isIssueRunning(issue) ||
      (event.target as Element).closest(".it-card-action")
    )
      return;
    const card = event.currentTarget;
    const dragged = (checked.includes(issue.id) ? checked : [issue.id]).filter(
      (id) => {
        const entry = issues.find((candidate) => candidate.id === id);
        return entry && !entry.archived && !isIssueRunning(entry);
      },
    );
    const { pointerId, clientX: startX, clientY: startY } = event;
    const rect = card.getBoundingClientRect();
    let ghost: HTMLElement | undefined;
    let target: IssueStatus | null = null;
    let restoreSelection: (() => void) | undefined;
    let x = startX;
    let y = startY;
    // In Progress is agent-owned, and a column every dragged card is already in is no target.
    const hit = () => {
      const status = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-drop-status]")?.dataset.dropStatus as
        IssueStatus | undefined;
      return status &&
        status !== "in_progress" &&
        dragged.some(
          (id) =>
            live.current.issues.find((entry) => entry.id === id)?.status !==
            status,
        )
        ? status
        : null;
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // The button is up but its pointerup never reached us: drop the drag.
      if (ev.pointerType === "mouse" && ev.buttons === 0) return finish(false);
      x = ev.clientX;
      y = ev.clientY;
      if (!ghost) {
        if (Math.hypot(x - startX, y - startY) < 5) return;
        restoreSelection = suppressTextSelection();
        document.documentElement.classList.add("is-issue-dragging");
        ghost = document.createElement("div");
        ghost.className = "issue-surface it-drag-ghost";
        ghost.style.width = `${rect.width}px`;
        const copy = card.cloneNode(true) as HTMLElement;
        copy.removeAttribute("data-issue-id");
        copy.setAttribute("aria-hidden", "true");
        copy.classList.remove("is-dragging");
        ghost.append(copy);
        if (dragged.length > 1) {
          const count = document.createElement("span");
          count.className = "it-drag-count";
          count.textContent = String(dragged.length);
          ghost.append(count);
        }
        document.body.append(ghost);
        try {
          card.setPointerCapture(pointerId);
        } catch {
          /* synthetic or already-released pointer */
        }
        setDragIds(dragged);
      }
      ghost.style.transform = `translate3d(${x - startX + rect.left}px, ${y - startY + rect.top}px, 0)`;
      const next = hit();
      if (next !== target) {
        target = next;
        setDropStatus(next);
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX;
      y = ev.clientY;
      finish(ev.type === "pointerup");
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // Cancel the drag without also clearing the selection.
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    function finish(commit: boolean) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
      cancelDrag.current = undefined;
      try {
        card.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
      if (!ghost) return;
      const status = commit ? hit() : null;
      ghost.remove();
      ghost = undefined;
      restoreSelection?.();
      document.documentElement.classList.remove("is-issue-dragging");
      setDragIds([]);
      setDropStatus(null);
      skipClickUntil.current = performance.now() + 400;
      if (!status) return;
      for (const id of dragged) {
        const entry = live.current.issues.find((issue) => issue.id === id);
        if (entry && entry.status !== status && !isIssueRunning(entry))
          void live.current.move(id, status).catch(live.current.showError);
      }
    }
    cancelDrag.current = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
  };
  const issueRow = (issue: LocalIssue) => (
    <div
      className={`it-card ${layout === "list" ? "it-list-row" : ""} ${checked.includes(issue.id) ? "is-checked" : ""} ${dragIds.includes(issue.id) ? "is-dragging" : ""}`}
      key={issue.id}
      data-issue-id={issue.id}
      onContextMenu={(event) => {
        event.preventDefault();
        setContext({ id: issue.id, x: event.clientX, y: event.clientY });
      }}
      onPointerDown={(event) => startDrag(event, issue)}
      onDragStart={(event) => event.preventDefault()}
    >
      <button
        className="it-card-open"
        onClick={(event) => clickIssue(event, issue.id)}
        onFocus={() => {
          lastFocus.current = issue.id;
        }}
        // Space toggles the check (handled on keydown); a button would also click on keyup.
        onKeyUp={(event) => {
          if (event.key === " ") event.preventDefault();
        }}
        aria-pressed={checked.includes(issue.id)}
        aria-label={`Open MC-${issue.number}: ${issue.title}`}
      >
        <span className="it-card-id">
          MC-{issue.number}
          {issue.commitSha ? <CommitChip issue={issue} /> : null}
        </span>
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
          {isIssueRunning(issue) ? (
            <>
              <LoaderCircle className="it-icon animate-spin" />
              {issue.runState === "starting"
                ? "Starting agent"
                : "Agent is working"}
            </>
          ) : peerReviewOf(issue.id)?.state === "running" ? (
            <>
              <LoaderCircle className="it-icon animate-spin" />
              Reviewing with {peerReviewOf(issue.id)?.model}…
            </>
          ) : peerReviewOf(issue.id)?.state === "failed" ? (
            <span className="it-error">Review failed</span>
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
        disabled={isIssueRunning(issue)}
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
  const dropClass = (status: IssueStatus) =>
    dropStatus === status ? " it-drop-target" : "";
  const viewTitle = view === "archive" ? "Archived issues" : "Issues";
  return (
    <div
      ref={rootRef}
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
            {onOpenGithub ? (
              <button onClick={onOpenGithub}>
                <GitPullRequest className="it-icon" />
                GitHub
              </button>
            ) : null}
          </nav>
          <button
            type="button"
            className="it-sidebar-heading"
            aria-expanded={navOpen.workspace}
            onClick={() =>
              setNavOpen((previous) => ({
                ...previous,
                workspace: !previous.workspace,
              }))
            }
          >
            Workspace
            <ChevronDown className="it-icon" />
          </button>
          <nav hidden={!navOpen.workspace}>
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
          <button
            type="button"
            className="it-sidebar-heading"
            aria-expanded={navOpen.projects}
            onClick={() =>
              setNavOpen((previous) => ({
                ...previous,
                projects: !previous.projects,
              }))
            }
          >
            Your projects
            <ChevronDown className="it-icon" />
          </button>
          <nav className="it-project-nav" hidden={!navOpen.projects}>
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
                    label: "Show empty groups",
                    checked: showEmpty,
                  },
                  {
                    value: "newest",
                    label: "Newest first",
                    checked: sort === "newest",
                  },
                  {
                    value: "oldest",
                    label: "Oldest first",
                    checked: sort === "oldest",
                  },
                  {
                    value: "priority",
                    label: "Priority",
                    checked: sort === "priority",
                  },
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
              className={`it-column${dropClass(status)}`}
              key={status}
              aria-label={`${ISSUE_STATUS_LABELS[status]} issues`}
              data-drop-status={status}
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
                {status === "in_progress" ? null : (
                  <button
                    className="it-icon-button it-column-action"
                    aria-label={`Create issue in ${ISSUE_STATUS_LABELS[status]}`}
                    onClick={() => setCreateStatus(status)}
                  >
                    <Plus className="it-icon" />
                  </button>
                )}
              </div>
              <div className="it-column-items">
                {visible
                  .filter((issue) => issue.status === status)
                  .map(issueRow)}
                {status === "in_progress" ? null : (
                  <button
                    className="it-add-row"
                    onClick={() => setCreateStatus(status)}
                  >
                    <Plus className="it-icon" />
                    Add issue
                  </button>
                )}
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
                  className={dropClass(status).trim()}
                  data-drop-status={status}
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
      {createShown ? (
        <NewIssue
          project={project || (cwd !== "~" ? cwd : "")}
          projects={projects}
          status={createShown}
          onClose={() => setCreateStatus(null)}
          onCreate={create}
          leaving={createLeaving}
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
          onReview={reviewIssue}
          onReadSession={onReadSession}
          onApproval={onApproval}
          onOpenSession={onOpenSession}
          onError={showError}
          leaving={detailLeaving}
        />
      ) : null}
      {notice ? (
        <div className="it-toast" role="status">
          <CheckCircle className="it-icon" />
          {notice}
        </div>
      ) : null}
      {reviewAt && issues.some((issue) => issue.id === reviewAt.id) ? (
        <ReviewPopover
          issue={issues.find((issue) => issue.id === reviewAt.id)!}
          anchor={reviewAt}
          onDismiss={() => setReviewAt(null)}
          onStart={(target) => {
            reviewIssue(reviewAt.id, target);
            setReviewAt(null);
          }}
        />
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
            disabled={isIssueRunning(
              issues.find((issue) => issue.id === context.id) ?? {},
            )}
            onChange={(value) => {
              for (const id of targets)
                void move(id, value as IssueStatus).catch(showError);
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
                for (const id of targets)
                  updateLocalIssue(id, { priority: Number(value) });
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
          {canPeerReview(
            issues.find((issue) => issue.id === context.id) ?? {},
          ) ? (
            <button
              role="menuitem"
              disabled={peerReviewOf(context.id)?.state === "running"}
              onClick={() => {
                setReviewAt(context);
                setContext(null);
              }}
            >
              <Bot className="it-icon" />
              Review with…
            </button>
          ) : null}
          <button
            role="menuitem"
            disabled={isIssueRunning(
              issues.find((issue) => issue.id === context.id) ?? {},
            )}
            onClick={() => {
              try {
                for (const id of targets) {
                  const issue = issues.find((issue) => issue.id === id)!;
                  if (isIssueRunning(issue)) continue;
                  updateLocalIssue(
                    id,
                    { archived: !issue.archived },
                    issue.archived
                      ? "Restored the issue"
                      : "Archived the issue",
                  );
                }
                setChecked([]);
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
