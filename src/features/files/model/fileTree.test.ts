import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../../../platform/tauri/fs";
import {
  forgetDir,
  listCachedDir,
  notifyDirsChanged,
  peekDir,
  refreshCachedDirs,
  refreshDir,
  subscribeDirsChanged,
} from "./fileTree";

const root = "/tmp/empty-project";

function entry(name: string): FsEntry {
  return {
    name,
    path: `${root}/${name}`,
    isDir: false,
    ignored: false,
  };
}

const listDir = vi.fn<(path: string) => Promise<FsEntry[]>>();

vi.mock("../../../platform/tauri/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../platform/tauri/fs")>();
  return {
    ...actual,
    listDir: (path: string) => listDir(path),
  };
});

describe("fileTree cache", () => {
  beforeEach(() => {
    forgetDir(root);
    listDir.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the first listing until refreshDir", async () => {
    listDir.mockResolvedValueOnce([]);
    await listCachedDir(root);
    expect(peekDir(root)).toEqual([]);

    listDir.mockResolvedValueOnce([entry("hello.ts")]);
    expect(await listCachedDir(root)).toEqual([]);
    expect(listDir).toHaveBeenCalledTimes(1);

    expect(await refreshDir(root)).toEqual([entry("hello.ts")]);
    expect(peekDir(root)).toEqual([entry("hello.ts")]);
  });

  it("refreshCachedDirs re-lists every cached folder", async () => {
    listDir.mockResolvedValueOnce([]);
    await listCachedDir(root);
    listDir.mockResolvedValueOnce([entry("created.ts")]);
    await refreshCachedDirs();
    expect(peekDir(root)).toEqual([entry("created.ts")]);
  });

  it("notifyDirsChanged refreshes the cache and tells listeners", async () => {
    vi.useFakeTimers();
    listDir.mockResolvedValueOnce([]);
    await listCachedDir(root);

    const onChange = vi.fn();
    const stop = subscribeDirsChanged(onChange, root);
    listDir.mockResolvedValueOnce([entry("from-agent.ts")]);
    notifyDirsChanged();
    expect(peekDir(root)).toEqual([]);

    await vi.runAllTimersAsync();
    expect(peekDir(root)).toEqual([entry("from-agent.ts")]);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("shares simultaneous reads and does not restore a forgotten late result", async () => {
    let resolve!: (rows: FsEntry[]) => void;
    listDir.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const first = listCachedDir(root);
    expect(listCachedDir(root)).toBe(first);
    expect(listDir).toHaveBeenCalledOnce();
    forgetDir(root);
    listDir.mockResolvedValueOnce([entry("new.ts")]);
    await listCachedDir(root);
    resolve([entry("old.ts")]);
    await first;
    expect(peekDir(root)).toEqual([entry("new.ts")]);
  });

  it("refreshes active trees and invalidates inactive trees without reading them", async () => {
    vi.useFakeTimers();
    listDir.mockResolvedValue([]);
    await listCachedDir(root);
    await listCachedDir(`${root}-inactive`);
    const stop = subscribeDirsChanged(() => undefined, root);
    listDir.mockClear();
    notifyDirsChanged();
    await vi.runAllTimersAsync();
    expect(listDir.mock.calls).toEqual([[root]]);
    expect(peekDir(`${root}-inactive`)).toBeNull();
    stop();
    forgetDir(`${root}-inactive`);
  });

  it("refreshes cold active reads that started before a write", async () => {
    vi.useFakeTimers();
    let resolveOld!: (rows: FsEntry[]) => void;
    listDir.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const old = listCachedDir(root);
    const stop = subscribeDirsChanged(() => undefined, root);
    try {
      listDir.mockResolvedValueOnce([entry("after-write.ts")]);
      notifyDirsChanged();
      await vi.runAllTimersAsync();
      expect(listDir).toHaveBeenCalledTimes(2);
      expect(await listCachedDir(root)).toEqual([entry("after-write.ts")]);
      resolveOld([entry("before-write.ts")]);
      await old;
      expect(peekDir(root)).toEqual([entry("after-write.ts")]);
    } finally { stop(); }
  });

  it("invalidates descendants when a parent refresh fails", async () => {
    listDir.mockResolvedValue([]);
    await listCachedDir(root);
    await listCachedDir(`${root}/child`);
    listDir.mockRejectedValueOnce(new Error("parent deleted"));
    await refreshCachedDirs([root]);
    expect(peekDir(root)).toBeNull();
    expect(peekDir(`${root}/child`)).toBeNull();
  });

  it("does not let an older failed refresh erase a newer parent listing", async () => {
    let rejectOld!: (error: Error) => void;
    listDir.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }));
    const oldRefresh = refreshCachedDirs([root]);
    listDir.mockResolvedValueOnce([entry("newer.ts")]);
    await refreshDir(root);
    rejectOld(new Error("old failure"));
    await oldRefresh;
    expect(peekDir(root)).toEqual([entry("newer.ts")]);
  });

  it("bounds concurrent refreshes and retained directory listings", async () => {
    listDir.mockResolvedValue([]);
    for (let i = 0; i < 300; i++) await listCachedDir(`${root}/${i}`);
    expect(peekDir(`${root}/0`)).toBeNull();
    expect(peekDir(`${root}/299`)).toEqual([]);
    let active = 0;
    let peak = 0;
    listDir.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return [];
    });
    await refreshCachedDirs();
    expect(peak).toBe(4);
  });

  it.each([
    ["/", "/tmp/root-child", "remote://host/tmp/root-child"],
    ["/tmp/tree/", "/tmp/tree/child", "/tmp/tree-sibling"],
    ["remote://host/tmp/tree/", "remote://host/tmp/tree/child", "remote://other/tmp/tree/child"],
  ])("refreshes children of %s without crossing path boundaries", async (activeRoot, child, outside) => {
    vi.useFakeTimers();
    listDir.mockResolvedValue([]);
    await listCachedDir(child);
    await listCachedDir(outside);
    const stop = subscribeDirsChanged(() => undefined, activeRoot);
    try {
      listDir.mockClear();
      notifyDirsChanged();
      await vi.runAllTimersAsync();
      expect(listDir.mock.calls.some(([path]) => path === child)).toBe(true);
      expect(listDir.mock.calls.some(([path]) => path === outside)).toBe(false);
      expect(peekDir(outside)).toBeNull();
    } finally {
      stop();
      forgetDir(child);
      forgetDir(outside);
    }
  });
});
