import { listDir, type FsEntry } from "../../../platform/tauri/fs";
import { pathSegments } from "./fileName";
import { isEqualOrInside, joinPath, parentPath } from "../../../shared/lib/paths";

const expandedByProject = new Map<string, Set<string>>();
const selectedByProject = new Map<string, string | null>();
const dirs = new Map<string, FsEntry[]>();
const pendingDirs = new Map<string, Promise<FsEntry[]>>();
const activeRoots = new Map<string, number>();
const MAX_CACHED_DIRS = 256;
const listeners = new Set<() => void>();

const REFRESH_MS = 150;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
let refreshAgain = false;

export function loadExpanded(cwd: string): Set<string> {
  const saved = expandedByProject.get(cwd);
  return saved ? new Set(saved) : new Set([cwd]);
}

export function saveExpanded(cwd: string, expanded: Set<string>) {
  expandedByProject.set(cwd, new Set(expanded));
}

export function loadSelected(cwd: string): string | null {
  return selectedByProject.get(cwd) ?? null;
}

export function saveSelected(cwd: string, path: string | null) {
  selectedByProject.set(cwd, path);
}

/** Cached `listDir` — same path stays instant when the tree remounts. */
export function peekDir(path: string): FsEntry[] | null {
  return dirs.get(path) ?? null;
}

export function listCachedDir(path: string): Promise<FsEntry[]> {
  const hit = dirs.get(path);
  if (hit) {
    dirs.delete(path);
    dirs.set(path, hit);
    return Promise.resolve(hit);
  }
  const pending = pendingDirs.get(path);
  if (pending) return pending;
  const request = listDir(path).then((entries) => {
    // A refresh or deletion may have invalidated this request while it ran.
    if (pendingDirs.get(path) === request) {
      dirs.set(path, entries);
      while (dirs.size > MAX_CACHED_DIRS) dirs.delete(dirs.keys().next().value!);
    }
    return entries;
  }).finally(() => {
    if (pendingDirs.get(path) === request) pendingDirs.delete(path);
  });
  pendingDirs.set(path, request);
  return request;
}

export function refreshDir(path: string): Promise<FsEntry[]> {
  dirs.delete(path);
  pendingDirs.delete(path);
  return listCachedDir(path);
}

export function forgetDir(path: string) {
  for (const key of [...dirs.keys()]) {
    if (key === path || key.startsWith(`${path}/`)) dirs.delete(key);
  }
  for (const key of pendingDirs.keys()) {
    if (key === path || key.startsWith(`${path}/`)) pendingDirs.delete(key);
  }
}

/** Re-list every cached folder. Agent writes and window focus use this. */
export async function refreshCachedDirs(paths = [...dirs.keys()]): Promise<void> {
  if (paths.length === 0) return;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (cursor < paths.length) {
      const path = paths[cursor++];
      // Failure invalidates this listing; it must not erase a newer request.
      try {
        await refreshDir(path);
      } catch {
        // A missing parent invalidates its children too. A newer parent read
        // must remain authoritative if this refresh lost a race with it.
        if (!pendingDirs.has(path) && !dirs.has(path)) forgetDir(path);
      }
    }
  }));
}

export function subscribeDirsChanged(listener: () => void, root?: string): () => void {
  listeners.add(listener);
  if (root) activeRoots.set(root, (activeRoots.get(root) ?? 0) + 1);
  return () => {
    listeners.delete(listener);
    if (root) {
      const remaining = (activeRoots.get(root) ?? 1) - 1;
      if (remaining) activeRoots.set(root, remaining);
      else activeRoots.delete(root);
    }
  };
}

/** Reload the explorer cache after an agent/shell write (debounced). */
export function notifyDirsChanged() {
  if (typeof document !== "undefined" && document.hidden) return;
  scheduleRefresh();
}

function scheduleRefresh() {
  if (refreshTimer != null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void runRefresh();
  }, REFRESH_MS);
}

async function runRefresh() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    const roots = [...activeRoots.keys()];
    const active = (path: string) => roots.some((root) => isEqualOrInside(path, root));
    const paths = new Set<string>();
    for (const path of dirs.keys()) {
      if (active(path)) paths.add(path);
      else dirs.delete(path); // Inactive projects reload on their next visit.
    }
    // Cold reads can have started before the write that triggered refresh.
    // Invalidate them too, then reread active paths through the same workers.
    for (const path of pendingDirs.keys()) {
      if (active(path)) paths.add(path);
      pendingDirs.delete(path);
    }
    await refreshCachedDirs([...paths]);
    for (const listener of listeners) listener();
  } finally {
    refreshing = false;
    if (refreshAgain) {
      refreshAgain = false;
      scheduleRefresh();
    }
  }
}

/** Folder to create into, given the explorer selection. */
export function createParentOf(cwd: string, selectedPath: string | null): string {
  if (!selectedPath || selectedPath === cwd) return cwd;
  const parent = parentPath(selectedPath);
  const entry = peekDir(parent)?.find((e) => e.path === selectedPath);
  if (entry?.isDir) return selectedPath;
  if (entry && !entry.isDir) return parent;
  if (peekDir(selectedPath)) return selectedPath;
  return parent;
}

/** Directories whose children change when creating `name` under `parent`. */
export function dirsTouchedByCreate(parent: string, name: string): string[] {
  const segments = pathSegments(name);
  const out = [parent];
  let cur = parent;
  for (let i = 0; i < segments.length - 1; i++) {
    cur = joinPath(cur, segments[i]);
    out.push(cur);
  }
  return out;
}

export function dirsTouchedByMove(from: string, to: string): string[] {
  const fromParent = parentPath(from);
  const toParent = parentPath(to);
  return fromParent === toParent ? [fromParent] : [fromParent, toParent];
}
