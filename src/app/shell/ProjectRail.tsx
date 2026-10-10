import {
  BellOff,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Internet,
  Inbox,
  MoreHorizontal,
  Pin,
  PinOff,
  File,
  Plus,
  Search,
  Settings,
  Zap,
} from "../../shared/ui/icons";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { useDragResize } from "../../shared/hooks/useDragResize";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { useProjectDiffStats } from "../../features/source-control/hooks/useProjectDiffStats";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { reorderMotion } from "../../shared/lib/motion";
import { useTabGroupLogos } from "../../features/projects/hooks/useTabGroupLogos";
import {
  loadProjectRailWidth,
  PROJECT_RAIL_WIDTH_DEFAULT,
  PROJECT_RAIL_WIDTH_MAX,
  PROJECT_RAIL_WIDTH_MIN,
  saveProjectRailWidth,
} from "../../features/settings/model/appearance";
import {
  basename,
  type GitDiffStats,
} from "../../platform/tauri/fs";
import { IS_MAC, MOD } from "../../platform/tauri/platform";
import { formatInteger } from "../../shared/lib/numbers";
import { pathKey, projectKey, projectName } from "../../shared/lib/paths";
import {
  collectRailProjects,
  loadPinnedProjects,
  loadProjectRailOrder,
  projectRailSections,
  sameProjectPath,
  savePinnedProjects,
  saveProjectRailOrder,
  subscribeProjectPathsChanged,
  syncProjectRailOrder,
  toggleProjectPin,
  type RecentProject,
} from "../../features/projects/model/recents";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupLogo,
  resolveTabGroupMascot,
} from "../../features/workspace/model/tabGroups";
import {
  loadProjectGroupAssignments,
  loadProjectGroups,
  projectGroupColor,
  projectGroupIdForPath,
  updateProjectGroup,
  type ProjectGroup,
} from "../../features/projects/model/projectGroups";
import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import { LiveAgentsPreview } from "../../features/sessions/ui/LiveAgentsPreview";
import { ProjectLogoIcon } from "../../features/projects/ui/ProjectLogoIcon";
import { ProjectMascot } from "../../features/projects/ui/ProjectMascot";
import { RailAction, RailSearch } from "./RailAction";
import {
  issueNumbersSnapshot,
  requestOpenIssue,
  subscribeIssueNumbers,
} from "../../features/inbox/model/issueReference";
import { DevModeSlot, TabVisitNav } from "./TitleBar";
import { SidebarUpdateFooter } from "./SidebarUpdate";
import type { InstalledUpdate } from "../model/updateNotice";
import { SettingsNav } from "./SettingsRail";
import { Shimmer } from "../../shared/ui/Shimmer";
import { resolveModel } from "../../features/sessions/model/models";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { NineDotSpinner } from "../../features/sessions/ui/NineDotSpinner";
import type { SettingsSectionId } from "../../features/settings/model/settings";
import { shortAgo, useMinuteClock } from "../../shared/lib/relativeTime";
import { InboxNotificationMenu } from "../../features/inbox/ui/InboxNotificationMenu";
import { notificationMuteStatus } from "../../features/notifications/ui/notificationMuteActions";
import { useProjectNotificationPreferences } from "../../features/notifications/hooks/useProjectNotificationPreferences";
import { useNotificationProjects } from "../../features/notifications/hooks/useNotificationProjects";
import { GithubStarPrompt } from "./GithubStarPrompt";
import { Popover } from "../../shared/ui/Popover";
import { OPEN_REMOTE_PROJECT_EVENT } from "../../features/connections/model/connections";
import {
  useRemoteMachineOnline,
  useRemoteMachines,
} from "../../features/connections/model/connections";
import { remoteProjectFor } from "../../features/connections/model/remoteProjects";
import { useProjectMenu } from "./useProjectMenu";
import { MonoRailSection, type MonoRailProps } from "./MonoRailSection";
import {
  listSessionsByProject,
  subscribeSessionStoreChanges,
  type SessionSummary,
} from "../../features/sessions/data/sessionStore";
import { compareSessionSummaries } from "../../features/sessions/data/sessionHistory";
import { sessionDisplayTitle } from "../../features/sessions/model/session";
import { isMonoSession } from "../../features/monos/model/mono";
import { isHabitRun } from "../../features/monos/model/monoHabits";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../features/files/ui/ExplorerMenu";

/** Chats listed under each project on the rail. */
export type ProjectThreads = {
  /** The current project's chats, including live and unsaved ones. */
  current: readonly SessionSummary[];
  /** The current project's chats are not listed yet, so an empty list is unknown rather than empty. */
  loading?: boolean;
  activeSessionId?: string;
  busyIds: ReadonlySet<string>;
  approvalIds: ReadonlySet<string>;
  unseenIds: ReadonlySet<string>;
  onSelect: (sessionId: string) => void;
  /** Opens the project and starts a new chat in it. */
  onNew: (projectPath: string) => void;
  onArchive?: (session: SessionSummary, archived: boolean) => void;
  onDelete?: (session: SessionSummary) => void;
  onRename?: (session: SessionSummary, title: string) => void;
};

const ThreadsContext = createContext<
  (ProjectThreads & { cwd: string; issueNumbers: ReadonlyMap<string, number> }) | null
>(null);

/** Rows last shown per project, so switching away or re-expanding never flashes an empty list. */
const lastThreadRows = new Map<string, SessionSummary[]>();

const THREAD_PAGE = 5;
const THREADS_EXPANDED_KEY = "monocode.projectThreadsExpanded";

function loadThreadsExpanded(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(THREADS_EXPANDED_KEY) ?? "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function saveThreadsExpanded(key: string, expanded: boolean) {
  try {
    localStorage.setItem(
      THREADS_EXPANDED_KEY,
      JSON.stringify({ ...loadThreadsExpanded(), [key]: expanded }),
    );
  } catch {
    // private mode / quota
  }
}

/** Same rows the project's session list shows, minus archived ones. */
function isListedThread(session: SessionSummary): boolean {
  return (
    !session.archived &&
    !session.sidebarHidden &&
    !session.orchestrationLeadId &&
    !("ephemeral" in session && session.ephemeral) &&
    !isMonoSession(session.id) &&
    !isHabitRun(session.id)
  );
}

type Props = {
  visible?: boolean;
  cwd: string;
  recents: RecentProject[];
  inboxUnseen?: boolean;
  busyPaths?: Iterable<string>;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onNew?: () => void;
  onSearch?: () => void;
  searchActive?: boolean;
  onOpenInbox?: () => void;
  inboxActive?: boolean;
  notesEnabled?: boolean;
  onOpenNotes?: () => void;
  notesActive?: boolean;
  onOpenAutomations?: () => void;
  automationsActive?: boolean;
  onTogglePanel?: () => void;
  onSelectProject: (path: string) => void;
  onOpenProject: () => void;
  onRemoveProject?: (path: string, options: { purgeData: boolean }) => void;
  liveAgents?: LiveAgent[];
  activeSessionId?: string;
  onSelectAgent?: (sessionId: string) => void;
  settingsOpen?: boolean;
  settingsSection?: SettingsSectionId;
  onOpenSettings?: () => void;
  onOpenNotificationSettings?: (projectPath?: string) => void;
  onSelectSettingsSection?: (section: SettingsSectionId) => void;
  onCloseSettings?: () => void;
  updateNotice?: InstalledUpdate | null;
  onOpenWhatsNew?: (version: string) => void;
  onDismissUpdate?: () => void;
  /** The Monos section above the projects; absent while Monos are off. */
  monos?: MonoRailProps;
  /** Lists each project's chats under it; absent leaves projects as plain rows. */
  threads?: ProjectThreads;
};

export function ProjectRail({
  visible = true,
  cwd,
  recents,
  inboxUnseen = false,
  busyPaths,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onNew,
  onSearch,
  searchActive = false,
  onOpenInbox,
  inboxActive = false,
  notesEnabled = true,
  onOpenNotes,
  notesActive = false,
  onOpenAutomations,
  automationsActive = false,
  onTogglePanel,
  onSelectProject,
  onOpenProject,
  onRemoveProject,
  liveAgents = [],
  activeSessionId,
  onSelectAgent,
  settingsOpen = false,
  settingsSection = "general",
  onOpenSettings,
  onOpenNotificationSettings,
  onSelectSettingsSection,
  onCloseSettings,
  updateNotice = null,
  onOpenWhatsNew,
  onDismissUpdate,
  monos,
  threads,
}: Props) {
  const resize = useDragResize({
    min: PROJECT_RAIL_WIDTH_MIN,
    max: () =>
      Math.min(PROJECT_RAIL_WIDTH_MAX, Math.floor(window.innerWidth * 0.35)),
    defaultWidth: PROJECT_RAIL_WIDTH_DEFAULT,
    initial: loadProjectRailWidth(),
    onCommit: saveProjectRailWidth,
  });
  const [railOrder, setRailOrder] = useState(loadProjectRailOrder);
  const [pinnedPaths, setPinnedPaths] = useState(loadPinnedProjects);
  const [groupLabels, setGroupLabels] = useState(loadTabGroupLabels);
  const [groupColors, setGroupColors] = useState(loadTabGroupColors);
  const [groupMascots, setGroupMascots] = useState(loadTabGroupMascots);
  const [groupCustomColors, setGroupCustomColors] = useState(
    loadTabGroupCustomColors,
  );
  const [projectGroups, setProjectGroups] = useState(loadProjectGroups);
  const [projectGroupAssignments, setProjectGroupAssignments] = useState(
    loadProjectGroupAssignments,
  );
  useEffect(
    () =>
      subscribeProjectPathsChanged(() => {
        setRailOrder(loadProjectRailOrder());
        setPinnedPaths(loadPinnedProjects());
        setGroupLabels(loadTabGroupLabels());
        setGroupColors(loadTabGroupColors());
        setGroupMascots(loadTabGroupMascots());
        setGroupCustomColors(loadTabGroupCustomColors());
        setProjectGroups(loadProjectGroups());
        setProjectGroupAssignments(loadProjectGroupAssignments());
      }),
    [],
  );
  const [inboxMenu, setInboxMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const projectMenu = useProjectMenu({
    onRemoveProject,
    onOpenNotificationSettings,
    onOpen: () => setInboxMenu(null),
  });
  useEffect(() => {
    if (visible) return;
    projectMenu.dismiss();
    setInboxMenu(null);
  }, [visible]);
  const notificationPreferences = useProjectNotificationPreferences();
  const allProjects = useMemo(
    () => collectRailProjects(recents, cwd),
    [cwd, recents],
  );
  const notificationProjects = useNotificationProjects([...allProjects.keys()]);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const groupLogos = useTabGroupLogos();
  const muteStatuses = new Map<string, string | null>();
  for (const project of notificationProjects.projects) {
    const status = notificationMuteStatus(notificationPreferences[project.id]);
    for (const path of project.paths) muteStatuses.set(pathKey(path), status);
  }
  const sections = useMemo(
    () => projectRailSections(recents, cwd, railOrder, pinnedPaths),
    [cwd, pinnedPaths, railOrder, recents],
  );
  const groupedProjectSections = useMemo(() => {
    const byGroup = new Map<string, RecentProject[]>(
      projectGroups.map((group) => [group.id, []]),
    );
    const ungrouped: RecentProject[] = [];
    for (const project of sections.projects) {
      const groupId = projectGroupIdForPath(
        project.path,
        projectGroupAssignments,
      );
      const items = groupId ? byGroup.get(groupId) : undefined;
      if (items) items.push(project);
      else ungrouped.push(project);
    }
    return {
      ungrouped,
      grouped: projectGroups.map((group) => ({
        group,
        items: byGroup.get(group.id) ?? [],
      })),
    };
  }, [projectGroupAssignments, projectGroups, sections.projects]);
  const busy = useMemo(() => {
    const set = new Set<string>();
    for (const path of busyPaths ?? []) set.add(path);
    return set;
  }, [busyPaths]);

  useEffect(() => {
    setRailOrder((prev) => {
      const synced = syncProjectRailOrder(prev, allProjects);
      if (synced.join("\0") === prev.join("\0")) return prev;
      saveProjectRailOrder(synced);
      return synced;
    });
  }, [allProjects]);

  useEffect(() => {
    // Saving announces the change, which reloads `pinnedPaths`.
    const pinned = loadPinnedProjects();
    const next = pinned.filter((path) => allProjects.has(path));
    if (next.length !== pinned.length) savePinnedProjects(next);
  }, [allProjects]);

  useEffect(() => {
    if (!projectMenu.isOpen) return;
    const onScroll = () => projectMenu.close();
    const scrollParent = scrollRef.current ?? window;
    scrollParent.addEventListener("scroll", onScroll, true);
    return () => scrollParent.removeEventListener("scroll", onScroll, true);
  }, [projectMenu.isOpen]);

  const onProjectContextMenu = (
    path: string,
    event: MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
    projectMenu.open(path, event.clientX, event.clientY);
  };

  const reorderSubset = (
    fullOrder: string[],
    subsetOrder: string[],
    subsetPaths: Set<string>,
  ) => {
    const next: string[] = [];
    let subsetIndex = 0;
    for (const path of fullOrder) {
      if (!subsetPaths.has(path)) {
        next.push(path);
        continue;
      }
      if (subsetIndex < subsetOrder.length) {
        next.push(subsetOrder[subsetIndex++]);
      }
    }
    return next;
  };

  const onReorderPinned = (ids: string[]) => {
    const subset = new Set(sections.pinned.map((item) => item.path));
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  const onReorderProjects = (ids: string[]) => {
    const subset = new Set(ids);
    const next = reorderSubset(railOrder, ids, subset);
    setRailOrder(next);
    saveProjectRailOrder(next);
  };

  // Another view in the main area means no project row is the current one.
  const otherViewActive =
    searchActive ||
    inboxActive ||
    notesActive ||
    automationsActive ||
    !!monos?.activeId;
  const pinnedIds = sections.pinned.map((item) => item.path);
  const projectIds = groupedProjectSections.ungrouped.map((item) => item.path);
  const pinnedSortable = useAnimatedReorder(pinnedIds, onReorderPinned, "y");
  const projectSortable = useAnimatedReorder(projectIds, onReorderProjects, "y");
  const issueNumbers = useSyncExternalStore(subscribeIssueNumbers, issueNumbersSnapshot);
  const threadsContext = useMemo(
    () => (threads ? { ...threads, cwd, issueNumbers } : null),
    [threads, cwd, issueNumbers],
  );
  return (
    <ThreadsContext.Provider value={threadsContext}>
      <nav
        ref={resize.setPaneRef}
        aria-label="Projects"
        className={`sidebar-glass relative shrink-0 flex-col border-r border-stroke ${visible ? "flex" : "hidden"}`}
      >
        <div
          className="flex h-10 shrink-0 select-none items-center pr-1.5"
          data-tauri-drag-region="deep"
        >
          {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
          <DevModeSlot />
          <TabVisitNav
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
            onTogglePanel={settingsOpen ? undefined : onTogglePanel}
            panelActive
          />
        </div>

        {settingsOpen ? (
          <SettingsNav
            section={settingsSection}
            onSelect={(next) => onSelectSettingsSection?.(next)}
            onClose={() => onCloseSettings?.()}
          />
        ) : (
          <>
            <div className="flex shrink-0 flex-col gap-px px-2 pb-2 pt-0.5">
              {onNew ? (
                <>
                  <RailAction
                    label="New thread"
                    icon={Plus}
                    onClick={onNew}
                    shortcut={`${MOD}N`}
                    ariaLabel={`New thread (${MOD}N)`}
                  />
                  <div className="mt-0.5" />
                </>
              ) : null}
              <RailSearch
                label="Search"
                icon={Search}
                onClick={onSearch}
                active={searchActive}
                shortcut={`${MOD}K`}
                ariaLabel={`Search (${MOD}K)`}
              />
              <div className="mt-0.5" />
              <RailAction
                label="Inbox"
                icon={Inbox}
                onClick={onOpenInbox}
                onOpenContextMenu={(x, y) => {
                  menuTrigger.current =
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null;
                  projectMenu.close();
                  setInboxMenu({ x, y });
                }}
                active={inboxActive}
                dot={inboxUnseen}
                ariaLabel={inboxUnseen ? "Inbox, new items" : "Inbox"}
              />
              {notesEnabled ? (
                <RailAction
                  label="Notes"
                  icon={File}
                  onClick={onOpenNotes}
                  active={notesActive}
                  ariaLabel="Notes"
                />
              ) : null}
              <RailAction
                label="Automations"
                icon={Zap}
                onClick={onOpenAutomations}
                active={automationsActive}
                ariaLabel="Automations"
              />
            </div>

            <div
              ref={(el) => {
                lockOverscroll(el);
                scrollRef.current = el;
              }}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2"
            >
              {monos ? (
                <MonoRailSection
                  {...monos}
                  introAvailable={visible && !!monos.introAvailable}
                />
              ) : null}

              {sections.pinned.length > 0 ? (
                <ProjectSection
                  label="Pinned"
                  items={sections.pinned}
                  muteStatuses={muteStatuses}
                  cwd={cwd}
                  busy={busy}
                  statsEnabled={visible}
                  sortable={pinnedSortable}
                  pinned
                  searchActive={otherViewActive}
                  onSelect={onSelectProject}
                  onTogglePin={toggleProjectPin}
                  onContextMenu={onProjectContextMenu}
                  onOpenMenu={projectMenu.open}
                  groupLabels={groupLabels}
                  groupColors={groupColors}
                  groupCustomColors={groupCustomColors}
                  groupLogos={groupLogos}
                  groupMascots={groupMascots}
                />
              ) : null}

              {projectGroups.length > 0 ? (
                <div className="mb-2 shrink-0">
                  <ProjectSectionHeader
                    label="Groups"
                    onAddGroup={(x, y) => projectMenu.createGroup(x, y)}
                  />
                  <div className="flex flex-col gap-px px-2">
                    {groupedProjectSections.grouped.map(({ group, items }) => (
                      <ProjectGroupSection
                        key={group.id}
                        group={group}
                        items={items}
                        muteStatuses={muteStatuses}
                        cwd={cwd}
                        busy={busy}
                        statsEnabled={visible}
                        searchActive={otherViewActive}
                        onSelect={onSelectProject}
                        onTogglePin={toggleProjectPin}
                        onContextMenu={onProjectContextMenu}
                        onOpenMenu={projectMenu.open}
                        onReorder={onReorderProjects}
                        onToggleCollapsed={() =>
                          updateProjectGroup(group.id, (current) => ({
                            ...current,
                            collapsed: !current.collapsed,
                          }))
                        }
                        onOpenGroupMenu={(x, y) =>
                          projectMenu.openGroupMenu(group.id, x, y)
                        }
                        groupLabels={groupLabels}
                        groupColors={groupColors}
                        groupCustomColors={groupCustomColors}
                        groupLogos={groupLogos}
                        groupMascots={groupMascots}
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <ProjectSection
                label="Projects"
                items={groupedProjectSections.ungrouped}
                muteStatuses={muteStatuses}
                emptyLabel={
                  sections.projects.length === 0 && projectGroups.length === 0
                    ? "No projects yet"
                    : undefined
                }
                onAdd={onOpenProject}
                cwd={cwd}
                busy={busy}
                statsEnabled={visible}
                sortable={projectSortable}
                pinned={false}
                searchActive={otherViewActive}
                onSelect={onSelectProject}
                onTogglePin={toggleProjectPin}
                onContextMenu={onProjectContextMenu}
                onOpenMenu={projectMenu.open}
                groupLabels={groupLabels}
                groupColors={groupColors}
                groupCustomColors={groupCustomColors}
                groupLogos={groupLogos}
                groupMascots={groupMascots}
              />
            </div>
            <LiveAgentsPreview
              agents={liveAgents}
              activeSessionId={activeSessionId}
              onSelect={onSelectAgent}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupMascots={groupMascots}
            />
            <SidebarUpdateFooter
              update={updateNotice}
              onOpenWhatsNew={onOpenWhatsNew}
              onDismissUpdate={onDismissUpdate}
            />
            <div className="flex shrink-0 flex-col gap-px p-2">
              <GithubStarPrompt />
              <RailAction
                label="Settings"
                icon={Settings}
                onClick={onOpenSettings}
                shortcut={`${MOD},`}
                ariaLabel={`Settings (${MOD},)`}
              />
            </div>
          </>
        )}
        {visible ? projectMenu.element : null}
        {visible && inboxMenu ? (
          <InboxNotificationMenu
            {...inboxMenu}
            projectPaths={[...allProjects.keys()]}
            onOpenSettings={onOpenNotificationSettings}
            onClose={() => {
              setInboxMenu(null);
              menuTrigger.current?.focus();
            }}
          />
        ) : null}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize project sidebar"
          aria-valuenow={resize.width}
          aria-valuemin={PROJECT_RAIL_WIDTH_MIN}
          aria-valuemax={PROJECT_RAIL_WIDTH_MAX}
          className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
            resize.dragging ? "bg-content/15" : "hover:bg-content/10"
          }`}
          onPointerDown={resize.onPointerDown}
          onDoubleClick={resize.onDoubleClick}
        />
      </nav>
    </ThreadsContext.Provider>
  );
}

type SortableHandle = ReturnType<typeof useAnimatedReorder>;

function ProjectSection({
  label,
  items,
  muteStatuses,
  emptyLabel,
  onAdd,
  cwd,
  busy,
  statsEnabled,
  sortable,
  pinned,
  searchActive,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  label: string;
  items: RecentProject[];
  muteStatuses: ReadonlyMap<string, string | null>;
  emptyLabel?: string;
  onAdd?: () => void;
  cwd: string;
  busy: Set<string>;
  statsEnabled: boolean;
  sortable: SortableHandle;
  pinned: boolean;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  return (
    <div className="shrink-0 mb-2">
      <ProjectSectionHeader label={label} onAdd={onAdd} />
      {items.length === 0 && emptyLabel ? (
        <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">
          {emptyLabel}
        </p>
      ) : null}
      <div className="flex flex-col gap-px px-2">
        {items.map((item) => (
          <ProjectCard
            key={item.path}
            item={item}
            muteStatus={muteStatuses.get(pathKey(item.path)) ?? undefined}
            selected={!searchActive && sameProjectPath(item.path, cwd)}
            busy={isBusyPath(item.path, busy)}
            statsEnabled={statsEnabled}
            pinned={pinned}
            sortable={sortable}
            onSelect={onSelect}
            onTogglePin={onTogglePin}
            onContextMenu={onContextMenu}
            onOpenMenu={onOpenMenu}
            groupLabels={groupLabels}
            groupColors={groupColors}
            groupCustomColors={groupCustomColors}
            groupLogos={groupLogos}
            groupMascots={groupMascots}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectSectionHeader({
  label,
  onAdd,
  onAddGroup,
}: {
  label: string;
  onAdd?: () => void;
  onAddGroup?: (x: number, y: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
      {/* As tall as the header buttons, so every section header matches. */}
      <span className="min-w-0 flex-1 truncate px-1 text-xs leading-5 text-content/50">
        {label}
      </span>
      {onAddGroup ? (
        <button
          type="button"
          title="New project group"
          aria-label="New project group"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onAddGroup(rect.left, rect.bottom);
          }}
          className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content"
        >
          <FolderPlus className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
      {onAdd ? <AddProjectButton onOpenFolder={onAdd} /> : null}
    </div>
  );
}

function ProjectGroupSection({
  group,
  items,
  muteStatuses,
  cwd,
  busy,
  statsEnabled,
  searchActive,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  onReorder,
  onToggleCollapsed,
  onOpenGroupMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  group: ProjectGroup;
  items: RecentProject[];
  muteStatuses: ReadonlyMap<string, string | null>;
  cwd: string;
  busy: Set<string>;
  statsEnabled: boolean;
  searchActive: boolean;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  onReorder: (ids: string[]) => void;
  onToggleCollapsed: () => void;
  onOpenGroupMenu: (x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  const sortable = useAnimatedReorder(
    items.map((item) => item.path),
    onReorder,
    "y",
  );
  const countLabel = `${items.length} ${items.length === 1 ? "project" : "projects"}`;
  const expanded = !group.collapsed;
  const openMenu = (target: HTMLElement, x?: number, y?: number) => {
    const rect = target.getBoundingClientRect();
    onOpenGroupMenu(x ?? rect.left, y ?? rect.bottom);
  };

  return (
    <div
      className={`shrink-0 overflow-hidden rounded-md ${
        expanded ? "mb-1.5 bg-content/5" : ""
      }`}
      data-project-group={group.id}
      role="group"
      aria-label={group.name}
    >
      <div
        className="project-reorder-item group relative flex h-8 items-stretch rounded-md px-2 opacity-65 cursor-default"
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
          openMenu(event.currentTarget, event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          aria-expanded={!group.collapsed}
          aria-label={`${group.name}, ${countLabel}`}
          title={`${group.name} · ${countLabel}`}
          onClick={onToggleCollapsed}
          className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none group-hover:pr-6 group-has-[:focus-visible]:pr-6"
        >
          <div className="grid size-4 shrink-0 place-items-center">
            {group.collapsed ? (
              <>
                <span
                  data-group-mascot
                  className="grid size-4 place-items-center group-hover:hidden group-has-[:focus-visible]:hidden"
                >
                  <ProjectMascot
                    project={group.id}
                    color={projectGroupColor(group)}
                    name={group.mascot ?? null}
                    className="size-3"
                  />
                </span>
                <ChevronRight
                  data-group-chevron
                  className="hidden size-3.5 group-hover:block group-has-[:focus-visible]:block"
                  strokeWidth={1.75}
                />
              </>
            ) : (
              <ChevronDown
                data-group-chevron
                className="size-3.5"
                strokeWidth={1.75}
              />
            )}
          </div>
          <span className={nameClassName}>{group.name}</span>
        </button>
        <button
          type="button"
          data-no-drag
          title="Group options"
          aria-label={`${group.name} group options`}
          aria-haspopup="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            openMenu(event.currentTarget);
          }}
          className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid group-has-[:focus-visible]:grid"
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      {expanded ? (
        <div data-project-group-items className="flex flex-col gap-px p-1">
          {items.map((item) => (
            <ProjectCard
              key={item.path}
              item={item}
              muteStatus={muteStatuses.get(pathKey(item.path)) ?? undefined}
              selected={!searchActive && sameProjectPath(item.path, cwd)}
              busy={isBusyPath(item.path, busy)}
              statsEnabled={statsEnabled}
              pinned={false}
              sortable={sortable}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
              onContextMenu={onContextMenu}
              onOpenMenu={onOpenMenu}
              groupLabels={groupLabels}
              groupColors={groupColors}
              groupCustomColors={groupCustomColors}
              groupLogos={groupLogos}
              groupMascots={groupMascots}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const nameClassName =
  "min-w-0 flex-1 truncate text-sm font-medium leading-tight";

function ProjectCard({
  item,
  muteStatus,
  selected,
  busy,
  statsEnabled,
  pinned,
  sortable,
  onSelect,
  onTogglePin,
  onContextMenu,
  onOpenMenu,
  groupLabels,
  groupColors,
  groupCustomColors,
  groupLogos,
  groupMascots,
}: {
  item: RecentProject;
  muteStatus?: string;
  selected: boolean;
  busy: boolean;
  statsEnabled: boolean;
  pinned: boolean;
  sortable: SortableHandle;
  onSelect: (path: string) => void;
  onTogglePin: (path: string) => void;
  onContextMenu: (path: string, event: MouseEvent<HTMLElement>) => void;
  onOpenMenu: (path: string, x: number, y: number) => void;
  groupLabels: Record<string, string>;
  groupColors: Record<string, number>;
  groupCustomColors: Record<string, string>;
  groupLogos: ReturnType<typeof useTabGroupLogos>;
  groupMascots: Record<string, string>;
}) {
  const fallbackName = basename(item.path);
  const key = projectKey(item.path);
  const seed = projectName(item.path);
  const name = resolveTabGroupLabel(key, groupLabels, fallbackName);
  const logoPath = resolveTabGroupLogo(key, groupLogos);
  const color = resolveTabGroupColor(key, groupColors, groupCustomColors, seed);
  const diffEnabled = statsEnabled && Boolean(item.path) && item.path !== "~";
  const stats = useProjectDiffStats(item.path, diffEnabled);
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const hasChanges = files > 0 || additions > 0 || deletions > 0;
  const remote = remoteProjectFor(item.path);
  const { machines } = useRemoteMachines(!!remote);
  const machine = remote
    ? machines.find((entry) => entry.environmentId === remote.environmentId)
    : undefined;
  const online = useRemoteMachineOnline(machine?.id);
  const connection = !remote
    ? ""
    : !machine
      ? "Machine not connected on this computer"
      : online === undefined
        ? "Connecting"
        : online
          ? "Connected"
          : "Reconnecting";
  const cardTitle = projectCardTitle(
    remote
      ? `${remote.cwd} on ${machine?.name ?? "another machine"} (${connection})`
      : item.path,
    name,
    stats,
    busy,
  );
  const cardAriaLabel = projectCardAriaLabel(
    machine ? `${name} on ${machine.name}` : name,
    stats,
    busy,
  );
  const labelClassName = machine
    ? "min-w-0 max-w-[75%] shrink-0 truncate text-sm font-medium leading-tight"
    : nameClassName;
  const threads = useContext(ThreadsContext);
  const current = sameProjectPath(item.path, threads?.cwd ?? "");
  const [expanded, setExpanded] = useState(
    () => loadThreadsExpanded()[pathKey(item.path)] ?? current,
  );
  const toggleExpanded = () => {
    saveThreadsExpanded(pathKey(item.path), !expanded);
    setExpanded(!expanded);
  };
  const threadRows = useProjectThreadRows(
    item.path,
    !!threads && expanded,
    current,
    threads,
  );
  const [threadLimit, setThreadLimit] = useState(THREAD_PAGE);
  const shownThreads = threadRows?.slice(0, threadLimit) ?? [];
  const threadOrder = JSON.stringify(expanded ? shownThreads.map((row) => row.id) : []);
  const threadListRef = useThreadSlide(threadOrder);
  // The open chat carries the highlight once it is listed beneath.
  const headerSelected =
    selected &&
    !(
      threads &&
      expanded &&
      shownThreads.some((row) => row.id === threads.activeSessionId)
    );

  return (
    <div
      ref={(el) => sortable.setItemRef(item.path, el)}
      className="reorder-item flex flex-col"
    >
      <div
        data-selected={headerSelected || undefined}
        aria-expanded={threads ? expanded : undefined}
        className={`project-reorder-item group relative flex touch-none items-stretch rounded-md px-2 h-8 ${
          headerSelected
            ? "bg-selection-strong text-content"
            : "opacity-65"
        } cursor-default`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
            return;
          }
          sortable.onItemPointerDown(item.path, event);
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) {
            return;
          }
          if (sortable.consumeClick()) return;
          // Another machine's chats aren't listed here, so open it instead.
          if (threads && !(remote && !current)) toggleExpanded();
          else onSelect(item.path);
        }}
        onContextMenu={(event) => onContextMenu(item.path, event)}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          ) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(item.path, rect.left, rect.bottom);
        }}
      >
        <button
          type="button"
          title={muteStatus ? `${cardTitle}\n${muteStatus}` : cardTitle}
          aria-label={muteStatus ? `${cardAriaLabel}, ${muteStatus}` : cardAriaLabel}
          aria-current={headerSelected ? "true" : undefined}
          className={`flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 motion-reduce:transition-none ${
            threads
              ? "group-hover:pr-12 group-has-[:focus-visible]:pr-12"
              : "group-hover:pr-6 group-has-[:focus-visible]:pr-6"
          }`}
        >
          <div className="project-card-logo grid size-4 shrink-0 place-items-center transition-opacity group-hover:opacity-0">
            {logoPath && !busy ? (
              <ProjectLogoIcon
                path={logoPath}
                className="size-4 rounded-sm"
                imageClassName="size-4"
              />
            ) : (
              <ProjectMascot
                project={seed}
                color={color}
                name={resolveTabGroupMascot(key, groupMascots)}
                className="size-3"
                active={busy}
              />
            )}
          </div>
          <span className={labelClassName}>{name}</span>
          {machine ? (
            <span className="min-w-0 flex-1 truncate text-[11px] leading-tight text-content/45">
              {machine.name}
            </span>
          ) : null}
          {hasChanges ? (
            <span className="project-card-stats shrink-0 group-hover:hidden group-has-[:focus-visible]:hidden">
              <ProjectDiffStat additions={additions} deletions={deletions} />
            </span>
          ) : null}
          {remote ? (
            <span
              role="img"
              aria-label={connection}
              className="relative grid size-4 shrink-0 place-items-center text-content/45"
            >
              <Internet className="size-3" strokeWidth={1.75} aria-hidden="true" />
              <span
                aria-hidden="true"
                className={`absolute right-0 bottom-0 size-1.5 rounded-full ring-1 ring-background-base ${
                  online ? "bg-emerald-400" : "bg-content/35"
                }`}
              />
            </span>
          ) : null}
          {muteStatus ? (
            <span
              role="img"
              aria-label={muteStatus}
              title={muteStatus}
              className="grid size-4 shrink-0 place-items-center text-amber-400"
            >
              <BellOff className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            </span>
          ) : null}
        </button>
        <button
          type="button"
          data-no-drag
          title="Project options"
          aria-label="Project options"
          aria-haspopup="menu"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(
              item.path,
              event.detail === 0 ? rect.left : event.clientX,
              event.detail === 0 ? rect.bottom : event.clientY,
            );
          }}
          className={`absolute top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid group-has-[:focus-visible]:grid ${
            threads ? "right-7" : "right-1"
          }`}
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} />
        </button>
        {threads ? (
          <button
            type="button"
            data-no-drag
            title="New chat"
            aria-label={`New chat in ${name}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              threads.onNew(item.path);
            }}
            className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid group-has-[:focus-visible]:grid"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
        <button
          type="button"
          data-no-drag
          title={pinned ? "Unpin project" : "Pin project"}
          aria-label={pinned ? "Unpin project" : "Pin project"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin(item.path);
          }}
          className="absolute left-2 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-content/55 opacity-0 pointer-events-none transition-opacity hover:text-content group-hover:pointer-events-auto group-hover:opacity-100"
        >
          {pinned ? (
            <PinOff className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Pin className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
      </div>
      {threads ? (
        <div
          inert={!expanded}
          className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
        <ul ref={threadListRef} aria-label={`${name} chats`} className="relative flex min-h-0 flex-col gap-px overflow-hidden py-px">
          {threadRows?.length === 0 ? (
            <li className="h-7 pl-6 text-[12px] leading-7 text-content/35">
              No chats yet
            </li>
          ) : null}
          {shownThreads.map((row) => (
            <ThreadRow
              key={row.id}
              session={row}
              active={selected && row.id === threads.activeSessionId}
              busy={threads.busyIds.has(row.id)}
              approval={threads.approvalIds.has(row.id)}
              unseen={threads.unseenIds.has(row.id)}
              issueNumber={threads.issueNumbers.get(row.id)}
              onSelect={threads.onSelect}
              onArchive={threads.onArchive}
              onDelete={threads.onDelete}
              onRename={threads.onRename}
            />
          ))}
          {threadRows && threadRows.length > threadLimit ? (
            <li>
              <button
                type="button"
                onClick={() => setThreadLimit((limit) => limit + THREAD_PAGE)}
                className="flex h-7 w-full items-center rounded-md pl-6 text-left text-[12px] text-content/40 hover:bg-content/5 hover:text-content/70"
              >
                Show more
              </button>
            </li>
          ) : null}
        </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The current project's chats come from the live list; any other project's
 * are read from the store when expanded, and again after switching projects.
 */
function useProjectThreadRows(
  path: string,
  enabled: boolean,
  current: boolean,
  threads: ProjectThreads | null,
): SessionSummary[] | null {
  const [stored, setStored] = useState<SessionSummary[] | null>(null);
  const currentRows = threads?.current;
  const key = pathKey(path);
  // Before the first listing the live list is empty only because it is unknown.
  const liveRows = current && !(threads?.loading && !currentRows?.length) ? currentRows : undefined;
  useEffect(() => {
    if (liveRows) lastThreadRows.set(key, [...liveRows]);
  }, [key, liveRows]);
  const remote = !!remoteProjectFor(path);
  useEffect(() => {
    if (!enabled || current || remote) return;
    let cancelled = false;
    let revision = 0;
    const refresh = (changedPath?: string) => {
      if (changedPath && !sameProjectPath(path, changedPath)) return;
      const request = ++revision;
      void listSessionsByProject(path)
        .then((rows) => {
          if (cancelled || request !== revision) return;
          lastThreadRows.set(key, rows);
          setStored(rows);
        })
        .catch(() => undefined);
    };
    const unsubscribe = subscribeSessionStoreChanges(refresh);
    refresh();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, current, remote, path, key]);
  // Unknown until loaded (and never listed for another machine's project).
  const rows = liveRows ?? lastThreadRows.get(key) ?? stored;
  const busyIds = threads?.busyIds;
  const approvalIds = threads?.approvalIds;
  const unseenIds = threads?.unseenIds;
  return useMemo(
    () => {
      const needsAttention = (id: string) =>
        busyIds?.has(id) || approvalIds?.has(id) || unseenIds?.has(id);
      return rows
        ? rows.filter(isListedThread).sort((a, b) =>
            Number(!!needsAttention(b.id)) - Number(!!needsAttention(a.id)) ||
            compareSessionSummaries(a, b),
          )
        : null;
    },
    [rows, busyIds, approvalIds, unseenIds],
  );
}

/** Animate existing rows from their previous slots when attention changes. */
function useThreadSlide(order: string) {
  const list = useRef<HTMLUListElement>(null);
  const positions = useRef(new Map<string, number>());
  const animations = useRef(new Map<string, Animation>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const { duration, easing } = reorderMotion();
    for (const row of list.current?.querySelectorAll<HTMLElement>("[data-thread-id]") ?? []) {
      const id = row.dataset.threadId!;
      const top = row.offsetTop;
      next.set(id, top);
      const previous = positions.current.get(id);
      if (previous === undefined || previous === top) continue;
      animations.current.get(id)?.cancel();
      if (!reducedMotion && duration > 0 && typeof row.animate === "function") {
        animations.current.set(id, row.animate([
          { transform: `translateY(${previous - top}px)` },
          { transform: "translateY(0)" },
        ], { duration, easing }));
      }
    }
    for (const [id, animation] of animations.current) {
      if (!next.has(id) || reducedMotion) {
        animation.cancel();
        animations.current.delete(id);
      }
    }
    positions.current = next;
  }, [order]);
  useLayoutEffect(() => () => {
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
  }, []);
  return list;
}

const ThreadRow = memo(function ThreadRow({
  session,
  active,
  busy,
  approval,
  unseen,
  issueNumber,
  onSelect,
  onArchive,
  onDelete,
  onRename,
}: {
  session: SessionSummary;
  active: boolean;
  busy: boolean;
  approval: boolean;
  unseen: boolean;
  issueNumber?: number;
  onSelect: (sessionId: string) => void;
  onArchive?: ProjectThreads["onArchive"];
  onDelete?: ProjectThreads["onDelete"];
  onRename?: ProjectThreads["onRename"];
}) {
  const now = useMinuteClock();
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const renameFinished = useRef(false);
  const renaming = renameValue !== null;
  useEffect(() => {
    if (!renaming) return;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renaming]);
  const finishRename = (save: boolean) => {
    if (renameFinished.current) return;
    renameFinished.current = true;
    const title = renameValue?.trim();
    setRenameValue(null);
    if (save && title && title !== session.title) onRename?.(session, title);
  };
  const menuItems: ExplorerMenuItem[] = [
    ...(onRename
      ? [{ kind: "item" as const, id: "rename", label: "Rename", shortcut: "F2" }]
      : []),
    ...(onArchive
      ? [{ kind: "item" as const, id: "archive", label: session.archived ? "Unarchive" : "Archive" }]
      : []),
    ...(onDelete
      ? [{ kind: "item" as const, id: "delete", label: "Delete", danger: true }]
      : []),
  ];
  const title = sessionDisplayTitle(session.title, session.harness);
  const status = approval
    ? "Needs approval"
    : busy
      ? "Working"
      : unseen
        ? "Finished"
        : undefined;
  return (
    <li data-thread-id={session.id} className="group/thread relative">
      {renaming ? (
        <div className="flex h-7 items-center pl-8 pr-3">
          <input
            ref={renameInput}
            aria-label="Rename thread"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={() => finishRename(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finishRename(event.key === "Enter");
              }
            }}
            className="min-w-0 w-full rounded bg-content/10 px-1 text-[13px] text-content outline-none ring-1 ring-accent/40"
          />
        </div>
      ) : (
      <button
        type="button"
        title={status ? `${title}\n${status}` : title}
        aria-label={status ? `${title}, ${status}` : title}
        aria-current={active ? "true" : undefined}
        onClick={() => onSelect(session.id)}
        onKeyDown={(event) => {
          if (event.key === "F2" && onRename) {
            event.preventDefault();
            renameFinished.current = false;
            setRenameValue(title);
          }
        }}
        className={`flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg py-1 pl-8 pr-3 text-left text-[13px] ${
          active
            ? "bg-content/4 text-content"
            : "text-content/65 hover:bg-content/5 hover:text-content"
        }`}
      >
        <div className="min-w-0 flex-1">
          <span className="relative flex min-w-0 items-baseline gap-3">
            {busy && !approval ? (
              <NineDotSpinner className="absolute -left-5 top-1 text-accent" />
            ) : null}
            {busy ? (
              <Shimmer as="span" duration={1.4} className="min-w-0 flex-1 truncate font-medium">
                {title}
              </Shimmer>
            ) : (
              <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
            )}
            <time
              title={new Date(session.updatedAt).toLocaleString()}
              className={`shrink-0 text-[11px] font-normal tabular-nums text-content/40 ${menuItems.length ? "group-hover/thread:invisible group-focus-within/thread:invisible" : ""}`}
            >
              {shortAgo(session.updatedAt, now)}
            </time>
          </span>
          <span className={`mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-normal text-content/45 ${menuItems.length ? "group-hover/thread:pr-6 group-focus-within/thread:pr-6" : ""}`}>
            <HarnessIcon harness={session.harness} className="size-3 shrink-0" />
            <span className="truncate">{resolveModel(session.harness, session.model).name}</span>
            {issueNumber ? (
              <span
                role="link"
                title={`Open MC-${issueNumber} in the issue tracker`}
                onClick={(event) => {
                  event.stopPropagation();
                  requestOpenIssue(issueNumber);
                }}
                className="shrink-0 cursor-pointer text-accent hover:underline"
              >
                · MC-{issueNumber}
              </span>
            ) : null}
          </span>
        </div>
        {approval || unseen ? (
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${
              approval ? "bg-amber-400" : "bg-accent"
            }`}
          />
        ) : null}
      </button>
      )}
      {!renaming && menuItems.length ? (
        <button
          type="button"
          title="Thread actions"
          aria-label={`Actions for ${title}`}
          aria-haspopup="menu"
          aria-expanded={!!menuAnchor}
          onClick={(event) => {
            event.stopPropagation();
            setMenuAnchor(event.currentTarget);
          }}
          className={`absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${menuAnchor ? "" : "pointer-events-none opacity-0 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100"}`}
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} aria-hidden />
        </button>
      ) : null}
      {menuAnchor ? (
        <ExplorerMenu
          anchor={menuAnchor}
          items={menuItems}
          ariaLabel="Thread actions"
          onClose={() => setMenuAnchor(null)}
          onPick={(action) => {
            setMenuAnchor(null);
            if (action === "rename") {
              renameFinished.current = false;
              setRenameValue(title);
            }
            if (action === "archive") onArchive?.(session, !session.archived);
            if (action === "delete") onDelete?.(session);
          }}
        />
      ) : null}
    </li>
  );
});

function isBusyPath(path: string, busy: Set<string>): boolean {
  for (const other of busy) {
    if (sameProjectPath(path, other)) return true;
  }
  return false;
}

function ProjectDiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions <= 0 && deletions <= 0) return null;

  const label = [
    additions > 0 ? `+${formatInteger(additions)}` : "",
    deletions > 0 ? `-${formatInteger(deletions)}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      title={`${label} uncommitted`}
      className="flex shrink-0 items-center gap-1 font-sans text-[11px] font-semibold tabular-nums"
    >
      {additions > 0 ? (
        <span className="text-diff-add-fg">+{formatInteger(additions)}</span>
      ) : null}
      {deletions > 0 ? (
        <span className="text-diff-del-fg">-{formatInteger(deletions)}</span>
      ) : null}
    </span>
  );
}

function projectCardTitle(
  path: string,
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name, path];
  if (busy) parts.push("Working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0 || additions > 0 || deletions > 0) {
    parts.push(
      [
        files > 0 ? `${files} ${files === 1 ? "file" : "files"} changed` : "",
        additions > 0 ? `+${formatInteger(additions)}` : "",
        deletions > 0 ? `-${formatInteger(deletions)}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return parts.join("\n");
}

function projectCardAriaLabel(
  name: string,
  stats: GitDiffStats | null,
  busy: boolean,
): string {
  const parts = [name];
  if (busy) parts.push("working");
  const files = stats?.files ?? 0;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  if (files > 0) {
    parts.push(`${files} ${files === 1 ? "file" : "files"} changed`);
  }
  if (additions > 0) parts.push(`+${formatInteger(additions)}`);
  if (deletions > 0) parts.push(`-${formatInteger(deletions)}`);
  return parts.join(", ");
}

/** Adds a folder on this computer, or one on a connected machine. */
function AddProjectButton({ onOpenFolder }: { onOpenFolder: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const item =
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content/80 hover:bg-content/8 hover:text-content";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        title="Open project"
        aria-label="Open project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content aria-expanded:bg-content/8 aria-expanded:text-content"
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          align="start"
          width={230}
          onDismiss={() => setOpen(false)}
          role="menu"
          aria-label="Open project"
          className="p-1"
        >
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onOpenFolder();
            }}
          >
            <FolderPlus className="size-3.5 shrink-0" strokeWidth={1.75} />
            Open folder…
          </button>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              window.dispatchEvent(new Event(OPEN_REMOTE_PROJECT_EVENT));
            }}
          >
            <Internet className="size-3.5 shrink-0" strokeWidth={1.75} />
            Open folder on a machine…
          </button>
        </Popover>
      ) : null}
    </>
  );
}
