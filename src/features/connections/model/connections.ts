import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  applySessionSync,
  type HostCommand,
  type HostSession,
  type HostSessionSummary,
  type RemoteMachine,
  type SessionSync,
  type SessionSyncChunk,
  type SessionSyncResponse,
} from "./protocol";
import { remoteProjectFor } from "./remoteProjects";
import { withRemoteAttachmentPreviews } from "./remoteAttachmentPreviews";
import type { Block } from "../../sessions/model/session";

const CHANGE = "monocode:remote-machines";
export const REMOTE_HISTORY_CHANGE = "monocode:remote-history";
export const REMOTE_HISTORY_UPDATED = "monocode:remote-history-updated";
export const refreshRemoteProjectSessions = () =>
  window.dispatchEvent(new Event(REMOTE_HISTORY_CHANGE));
let cachedMachines: RemoteMachine[] = [];
let machinesLoaded = false;
let machinesRequest: Promise<RemoteMachine[]> | undefined;
function readRemoteMachines(): Promise<RemoteMachine[]> {
  if (machinesRequest) return machinesRequest;
  const request = invoke<RemoteMachine[]>("remote_machines");
  machinesRequest = request;
  const release = () => { if (machinesRequest === request) machinesRequest = undefined; };
  void request.then(release, release);
  return request;
}
export const OPEN_CONNECTIONS_EVENT = "monocode:open-connections";
export const OPEN_REMOTE_PROJECT_EVENT = "monocode:open-remote-project";
export const refreshRemoteMachines = () =>
  window.dispatchEvent(new Event(CHANGE));
const TAB_KEY = "monocode.remote-tabs.v2";
const WORKTREE_KEY = "monocode.remote-pending-worktrees.v1";

export function remotePendingWorktree(shellId: string): string | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(WORKTREE_KEY) ?? "{}")[
      shellId
    ];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The host checkout currently used by a remote tab. */
export function remoteTabCwd(project: string, shellId?: string): string | undefined {
  if (!shellId) return undefined;
  const sessionId = remoteSessionFor(shellId);
  return (
    (sessionId ? cachedRemoteSessionSummary(project, sessionId)?.cwd : undefined) ??
    remotePendingWorktree(shellId)
  );
}

export function rememberRemotePendingWorktree(shellId: string, path?: string) {
  try {
    const all = JSON.parse(localStorage.getItem(WORKTREE_KEY) ?? "{}");
    if (path) all[shellId] = path;
    else delete all[shellId];
    localStorage.setItem(WORKTREE_KEY, JSON.stringify(all));
  } catch {
    /* selection is restored from the host once a session exists */
  }
}

/** The host session a tab in a remote project shows; none for a new session. */
export function remoteSessionFor(shellId: string): string | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(TAB_KEY) ?? "{}")[shellId];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
export function rememberRemoteSession(shellId: string, sessionId?: string) {
  try {
    const all = JSON.parse(localStorage.getItem(TAB_KEY) ?? "{}");
    if (sessionId) all[shellId] = sessionId;
    else delete all[shellId];
    localStorage.setItem(TAB_KEY, JSON.stringify(all));
  } catch {
    /* tab selection is best effort */
  }
  window.dispatchEvent(new Event(REMOTE_HISTORY_CHANGE));
}

const pendingPrefix = (project: string, environment: string) =>
  `monocode.remote-command.v1:${JSON.stringify([project, environment])}:`;

type PendingEntry = { command: HostCommand; shellId?: string; followup?: HostCommand };
const readPendingEntry = (value: string): PendingEntry => {
  const parsed = JSON.parse(value) as PendingEntry | HostCommand;
  return "command" in parsed ? parsed : { command: parsed };
};

export const pendingRemoteFollowup = (project: string, environment: string, id: string) => {
  const value = localStorage.getItem(`${pendingPrefix(project, environment)}${id}`);
  return value ? readPendingEntry(value).followup : undefined;
};

export const pendingRemoteCommand = (
  project: string,
  environment: string,
  sessionId?: string | null,
  shellId?: string,
): HostCommand | undefined => {
  const prefix = pendingPrefix(project, environment);
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) {
      const value = localStorage.getItem(key);
      if (value) {
        const entry = readPendingEntry(value);
        const command = entry.command;
        if (
          sessionId === undefined ||
          (sessionId === null
            ? command.type === "create" && (!entry.shellId || entry.shellId === shellId)
            : command.type !== "create" && command.sessionId === sessionId)
        )
          return command;
      }
    }
  }
};

// Each command owns its storage entry: a late receipt from another pane can
// never erase this pane's uncertain request. Persistence must succeed before
// dispatch; unlike preferences, silently dropping an outbox entry is unsafe.
export const savePendingRemoteCommand = (
  project: string,
  environment: string,
  command: HostCommand,
  shellId?: string,
  followup?: HostCommand,
) => {
  try {
    localStorage.setItem(
      `${pendingPrefix(project, environment)}${command.commandId}`,
      JSON.stringify({ command, shellId,
        followup: followup ?? pendingRemoteFollowup(project, environment, command.commandId),
      } satisfies PendingEntry),
    );
  } catch {
    throw new Error(
      "Cannot save your request locally. Free up app storage before sending.",
    );
  }
};
export const clearPendingRemoteCommand = (
  project: string,
  environment: string,
  commandId: string,
) =>
  localStorage.removeItem(`${pendingPrefix(project, environment)}${commandId}`);

export function remoteRequest<T>(
  machineId: string,
  method: string,
  params: unknown = {},
): Promise<T> {
  return invoke<T>("remote_request", { machineId, method, params });
}

type RevisionWaiter = {
  sessionId: string;
  revision: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};
const revisionWaiters = new Map<string, Set<RevisionWaiter>>();
const waitingMachines = new Set<string>();
const activeRevisionWaits = new Map<string, { subscriptionId: string; waking: boolean }>();
function wakeRevisionWait(machineId: string) {
  const active = activeRevisionWaits.get(machineId);
  if (!active || active.waking) return;
  active.waking = true;
  void remoteRequest(machineId, "sessions.wake", { subscriptionId: active.subscriptionId }).catch(() => {
    // The bounded wait or its error still releases callers when waking fails.
  });
}

/** Multiplex panes over one authenticated request per machine. The host
 * returns revision notifications; authoritative data still comes from sync. */
export function waitForRemoteSession(machineId: string, sessionId: string, revision: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const promise = new Promise<void>((resolve, reject) => {
    const waiters = revisionWaiters.get(machineId) ?? new Set<RevisionWaiter>();
    revisionWaiters.set(machineId, waiters);
    const remove = () => {
      waiters.delete(waiter);
      signal.removeEventListener("abort", abort);
      if (!waiters.size && revisionWaiters.get(machineId) === waiters) revisionWaiters.delete(machineId);
    };
    const waiter: RevisionWaiter = { sessionId, revision,
      resolve: () => { remove(); resolve(); },
      reject: (error) => { remove(); reject(error); },
    };
    const abort = () => { waiter.resolve(); wakeRevisionWait(machineId); };
    waiters.add(waiter);
    signal.addEventListener("abort", abort, { once: true });
  });
  wakeRevisionWait(machineId);
  // Collect callers from the same update before opening a machine request.
  queueMicrotask(() => void runRevisionWait(machineId));
  return promise;
}

async function runRevisionWait(machineId: string) {
  if (waitingMachines.has(machineId)) return;
  const waiters = revisionWaiters.get(machineId);
  if (!waiters?.size) return;
  waitingMachines.add(machineId);
  const active = { subscriptionId: crypto.randomUUID(), waking: false };
  activeRevisionWaits.set(machineId, active);
  const batch = [...waiters];
  const cursors = new Map<string, number>();
  for (const waiter of batch) cursors.set(waiter.sessionId,
    Math.min(cursors.get(waiter.sessionId) ?? waiter.revision, waiter.revision));
  try {
    // More than 64 independently visible sessions use bounded batches.
    const selected = [...cursors].slice(0, 64);
    const changed = await remoteRequest<Record<string, number | null>>(machineId, "sessions.wait", {
      subscriptionId: active.subscriptionId,
      cursors: selected.map(([sessionId, revision]) => ({ sessionId, revision })),
    });
    activeRevisionWaits.delete(machineId);
    const timedOut = !Object.keys(changed).length;
    for (const waiter of batch)
      if (timedOut || (Object.prototype.hasOwnProperty.call(changed, waiter.sessionId) && changed[waiter.sessionId] !== waiter.revision)) waiter.resolve();
    // Rotate retained watchers so a continuously busy first batch cannot
    // starve later sessions when a machine has more than 64 subscribers.
    for (const waiter of batch) if (waiters.has(waiter) && selected.some(([id]) => id === waiter.sessionId)) {
      waiters.delete(waiter); waiters.add(waiter);
    }
  } catch (error) {
    for (const waiter of batch) waiter.reject(error);
  } finally {
    waitingMachines.delete(machineId);
    activeRevisionWaits.delete(machineId);
    if (revisionWaiters.get(machineId)?.size) queueMicrotask(() => void runRevisionWait(machineId));
  }
}

const pendingSyncs = new Map<string, Promise<SessionSync>>();

/** Reads one sync, assembling it from bounded pieces when the host chunks it. */
function syncRemoteSession(
  machineId: string,
  sessionId: string,
  revision?: number,
  options?: { projected?: boolean; startBlockId?: string; earlier?: boolean; all?: boolean; untilBlockId?: string },
  signal?: AbortSignal,
): Promise<SessionSync> {
  const key = JSON.stringify([machineId, sessionId, revision, options]);
  const pending = pendingSyncs.get(key);
  if (pending) return pending;
  const request = (async () => {
    const response = await remoteRequest<SessionSyncResponse>(machineId, "sessions.sync", { sessionId, revision, ...options });
    return readSyncResponse(machineId, sessionId, response);
  })();
  pendingSyncs.set(key, request);
  const remove = () => { if (pendingSyncs.get(key) === request) pendingSyncs.delete(key); };
  const settled = () => { remove(); signal?.removeEventListener("abort", remove); };
  signal?.addEventListener("abort", remove, { once: true });
  void request.then(settled, settled);
  return request;
}

async function readSyncResponse(machineId: string, sessionId: string, response: SessionSyncResponse): Promise<SessionSync> {
  if (response.kind !== "chunked") return response;
  if (!Number.isSafeInteger(response.length) || response.length <= 0 ||
    typeof response.transfer !== "string" || !response.transfer || response.transfer.length > 128)
    throw new Error("Invalid session transfer");
  const pieces: string[] = [];
  let offset = 0;
  while (offset < response.length) {
    const { data } = await remoteRequest<SessionSyncChunk>(
      machineId,
      "sessions.syncChunk",
      { sessionId, transfer: response.transfer, offset },
    );
    if (typeof data !== "string" || !data || data.length > response.length - offset)
      throw new Error("Session transfer ended early or exceeded its declared length");
    pieces.push(data);
    offset += data.length;
  }
  if (offset !== response.length)
    throw new Error("Session transfer has an unexpected length");
  return JSON.parse(pieces.join("")) as SessionSync;
}

/** Fetches only what changed since `known`; falls back to a full snapshot. */
export function loadRemoteSession(
  machineId: string,
  sessionId: string,
  known?: HostSession,
  signal?: AbortSignal,
  options?: { projected?: boolean; earlier?: boolean; all?: boolean; untilBlockId?: string },
): Promise<HostSession> {
  return readRemoteSession(machineId, sessionId, known, options, signal);
}

async function readRemoteSession(machineId: string, sessionId: string, known?: HostSession, options?: { projected?: boolean; earlier?: boolean; all?: boolean; untilBlockId?: string }, signal?: AbortSignal): Promise<HostSession> {
  const sync = (revision?: number) =>
    syncRemoteSession(machineId, sessionId, revision, { ...options, startBlockId: known?.session.blocks[0]?.id }, signal);
  const update = await sync(known?.revision);
  let snapshot: HostSession;
  try {
    snapshot = applySessionSync(known, update);
  } catch {
    snapshot = applySessionSync(undefined, await sync());
  }
  return withRemoteAttachmentPreviews(machineId, snapshot, known,
    (params) => remoteRequest(machineId, "attachments.read", params));
}

/** Tool detail uses the same bounded transfer protocol as transcript sync. */
export async function loadRemoteBlockDetail(machineId: string, sessionId: string, blockId: string, revision: number): Promise<Block> {
  const response = await remoteRequest<SessionSyncResponse>(machineId, "sessions.blockDetail", { sessionId, blockId, revision });
  const sync = await readSyncResponse(machineId, sessionId, response);
  if (sync.kind !== "snapshot" || sync.value.session.blocks[0]?.id !== blockId)
    throw new Error("Invalid tool detail response");
  return sync.value.session.blocks[0];
}

/** The connected machine for an environment, from the last machine list read. */
export function knownRemoteMachine(
  environmentId: string,
): RemoteMachine | undefined {
  return cachedMachines.find((entry) => entry.environmentId === environmentId);
}

/** The connected machine for an environment, reading the list when needed. */
export async function remoteMachineFor(
  environmentId: string,
): Promise<RemoteMachine | undefined> {
  const known = knownRemoteMachine(environmentId);
  if (known || machinesLoaded) return known;
  const value = await readRemoteMachines();
  cachedMachines = Array.isArray(value) ? value : [];
  machinesLoaded = true;
  return knownRemoteMachine(environmentId);
}

export async function connectMachine(
  name: string,
  url: string,
  token: string,
): Promise<RemoteMachine> {
  const machine = await invoke<RemoteMachine>("remote_connect", {
    name,
    url,
    token,
  });
  cachedMachines = [
    ...cachedMachines.filter((entry) => entry.id !== machine.id),
    machine,
  ];
  machinesLoaded = true;
  window.dispatchEvent(new Event(CHANGE));
  return machine;
}

export async function disconnectMachine(machineId: string): Promise<void> {
  await invoke("remote_disconnect", { machineId });
  cachedMachines = cachedMachines.filter((entry) => entry.id !== machineId);
  window.dispatchEvent(new Event(CHANGE));
}

export function useRemoteMachines(enabled = true): {
  machines: RemoteMachine[];
  loaded: boolean;
} {
  const [state, setState] = useState<{
    machines: RemoteMachine[];
    loaded: boolean;
  }>({ machines: cachedMachines, loaded: machinesLoaded });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const refresh = () => {
      void readRemoteMachines()
        .then((value) => {
          if (!disposed) {
            cachedMachines = Array.isArray(value) ? value : [];
            machinesLoaded = true;
            setState({
              machines: cachedMachines,
              loaded: true,
            });
          }
        })
        .catch(() => {
          // A temporary connection failure should not blank every remote
          // panel while a fresh machine list is requested.
          if (!disposed) setState({ machines: cachedMachines, loaded: true });
        });
    };
    refresh();
    window.addEventListener(CHANGE, refresh);
    return () => {
      disposed = true;
      window.removeEventListener(CHANGE, refresh);
    };
  }, [enabled]);
  return state;
}

const STATUS = "monocode:remote-machine-status";
const machineOnline = new Map<string, boolean>();
const statusWatchers = new Map<
  string,
  { count: number; timer?: ReturnType<typeof setTimeout> }
>();

/** Records whether a machine answered its latest request, for every view
 * that shows its connection state. */
export function reportRemoteMachineStatus(machineId: string, online: boolean) {
  if (machineOnline.get(machineId) === online) return;
  machineOnline.set(machineId, online);
  window.dispatchEvent(new Event(STATUS));
}

function watchMachineStatus(machineId: string): () => void {
  const existing = statusWatchers.get(machineId);
  if (existing) {
    existing.count++;
  } else {
    const watcher: { count: number; timer?: ReturnType<typeof setTimeout> } =
      { count: 1 };
    statusWatchers.set(machineId, watcher);
    let failures = 0;
    const poll = async () => {
      try {
        await remoteRequest(machineId, "environment.describe");
        failures = 0;
        reportRemoteMachineStatus(machineId, true);
      } catch {
        failures = Math.min(4, failures + 1);
        reportRemoteMachineStatus(machineId, false);
      }
      if (statusWatchers.get(machineId) === watcher)
        watcher.timer = setTimeout(
          () => void poll(),
          failures ? Math.min(30_000, 3_000 * 2 ** failures) : 15_000,
        );
    };
    void poll();
  }
  return () => {
    const watcher = statusWatchers.get(machineId);
    if (!watcher || --watcher.count > 0) return;
    clearTimeout(watcher.timer);
    statusWatchers.delete(machineId);
  };
}

/** Whether a machine is reachable; undefined until the first check returns. */
export function useRemoteMachineOnline(machineId?: string): boolean | undefined {
  const [online, setOnline] = useState(() =>
    machineId ? machineOnline.get(machineId) : undefined,
  );
  useEffect(() => {
    if (!machineId) {
      setOnline(undefined);
      return;
    }
    const update = () => setOnline(machineOnline.get(machineId));
    update();
    window.addEventListener(STATUS, update);
    const unwatch = watchMachineStatus(machineId);
    return () => {
      window.removeEventListener(STATUS, update);
      unwatch();
    };
  }, [machineId]);
  return online;
}

const historyKey = (project: string) => `monocode.remote-history.v2:${project}`;

function cachedSessions(project: string): HostSessionSummary[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(historyKey(project)) ?? "[]",
    );
    return Array.isArray(value) ? (value as HostSessionSummary[]) : [];
  } catch {
    return [];
  }
}
export function cachedRemoteSessionSummary(project: string, sessionId: string) {
  return cachedSessions(project).find((session) => session.id === sessionId);
}

export type RemoteProjectSessions = {
  /** Undefined when this machine is not connected on this computer. */
  machine?: RemoteMachine;
  sessions: HostSessionSummary[];
  loaded: boolean;
};

/** Lists a remote project's host sessions, keeping the last list visible
 * while the machine is unreachable. */
export function useRemoteProjectSessions(
  project: string,
  enabled = true,
): RemoteProjectSessions {
  const remote = enabled ? remoteProjectFor(project) : undefined;
  const { machines } = useRemoteMachines(!!remote);
  const machine = remote
    ? machines.find((entry) => entry.environmentId === remote.environmentId)
    : undefined;
  const [sessions, setSessions] = useState<HostSessionSummary[]>(() =>
    remote ? cachedSessions(project) : [],
  );
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!remote) return;
    const changed = () => setRefresh((value) => value + 1);
    window.addEventListener(REMOTE_HISTORY_CHANGE, changed);
    return () => window.removeEventListener(REMOTE_HISTORY_CHANGE, changed);
  }, [!!remote]);
  useEffect(() => {
    setSessions(remote ? cachedSessions(project) : []);
    setLoaded(false);
    if (!remote || !machine) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const next = await remoteRequest<HostSessionSummary[]>(
          machine.id,
          "sessions.list",
          { projectId: remote.projectId },
        );
        if (disposed) return;
        failures = 0;
        setSessions(next);
        setLoaded(true);
        try {
          localStorage.setItem(historyKey(project), JSON.stringify(next));
          window.dispatchEvent(new Event(REMOTE_HISTORY_UPDATED));
        } catch {
          /* the list is refetched next time */
        }
      } catch {
        // Keep the cached list and back off while SSH is unavailable.
        failures = Math.min(4, failures + 1);
      }
      if (!disposed)
        timer = setTimeout(
          () => void poll(),
          failures ? Math.min(30_000, 3_000 * 2 ** failures) : 3_000,
        );
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [project, remote?.projectId, machine?.id, refresh]);
  return { machine, sessions, loaded };
}
