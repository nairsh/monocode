import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInboxCache,
  githubPrDiff,
  githubWorkItemDetails,
  githubWorkItemThread,
  peekGithubWorkItemDetails,
  peekGithubWorkItemThread,
  peekGithubPrDiff,
  type GithubPrDiff,
} from "./githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mocked = vi.mocked(invoke);

describe("github work item freshness", () => {
  beforeEach(() => {
    clearInboxCache();
    mocked.mockReset();
    mocked.mockImplementation(async (command: string) =>
      command === "git_github_pr_diff"
        ? { additions: 0, deletions: 0, files: [], patch: "", truncated: false }
        : command === "git_github_work_item_thread"
          ? { comments: [], commits: [], truncated: false }
          : { body: "", author: "" },
    );
  });

  it("shares an in-flight details request", async () => {
    await Promise.all([
      githubWorkItemDetails("/repo", "o/r", "pr", 1),
      githubWorkItemDetails("/repo", "o/r", "pr", 1),
    ]);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("reuses recent data only when the caller allows it", async () => {
    await githubWorkItemDetails("/repo", "o/r", "pr", 1);
    await githubWorkItemThread("/repo", "o/r", "pr", 1);
    await githubPrDiff("/repo", "o/r", 1);
    expect(mocked).toHaveBeenCalledTimes(3);

    await githubWorkItemDetails("/repo", "o/r", "pr", 1, { maxAgeMs: 30_000 });
    await githubWorkItemThread("/repo", "o/r", "pr", 1, { maxAgeMs: 30_000 });
    await githubPrDiff("/repo", "o/r", 1, { maxAgeMs: 30_000 });
    expect(mocked).toHaveBeenCalledTimes(3);

    await githubWorkItemDetails("/repo", "o/r", "pr", 1);
    expect(mocked).toHaveBeenCalledTimes(4);
  });

  it("does not let invalidated detail reads repopulate a cleared cache", async () => {
    let resolve!: (value: { body: string; author: string }) => void;
    mocked.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = githubWorkItemDetails("/repo", "o/r", "pr", 1);
    clearInboxCache();
    resolve({ body: "old account's data", author: "old" });
    await old;
    expect(peekGithubWorkItemDetails("o/r", "pr", 1)).toBeNull();
  });

  it("keeps the newest forced thread refresh when an older request finishes late", async () => {
    let resolveOld!: (value: { comments: []; commits: []; truncated: boolean }) => void;
    mocked.mockImplementationOnce(() => new Promise((done) => { resolveOld = done; }));
    const old = githubWorkItemThread("/repo", "o/r", "pr", 1);
    await githubWorkItemThread("/repo", "o/r", "pr", 1, { force: true });
    const current = peekGithubWorkItemThread("o/r", "pr", 1);
    resolveOld({ comments: [], commits: [], truncated: true });
    await old;
    expect(peekGithubWorkItemThread("o/r", "pr", 1)).toBe(current);
    expect(current?.truncated).toBe(false);
  });

  it("bounds small PR diffs by count while retaining recently visited entries", async () => {
    for (let number = 1; number <= 32; number += 1) await githubPrDiff("/repo", "o/r", number);
    const recent = peekGithubPrDiff("o/r", 1);
    await githubPrDiff("/repo", "o/r", 33);
    expect(peekGithubPrDiff("o/r", 1)).toBe(recent);
    expect(peekGithubPrDiff("o/r", 2)).toBeNull();
    expect(peekGithubPrDiff("o/r", 33)).not.toBeNull();
  });

  it("bounds retained patch bytes before reaching the entry ceiling", async () => {
    const diff: GithubPrDiff = { additions: 1, deletions: 0, files: [], patch: "x".repeat(512 * 1024), truncated: false };
    mocked.mockResolvedValue(diff);
    for (let number = 1; number <= 20; number += 1) await githubPrDiff("/repo", "o/r", number);
    const retained = Array.from({ length: 20 }, (_, index) => peekGithubPrDiff("o/r", index + 1)).filter(Boolean);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThanOrEqual(15);
    expect(retained.reduce((bytes, entry) => bytes + entry!.patch.length * 2, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(peekGithubPrDiff("o/r", 1)).toBeNull();
    expect(peekGithubPrDiff("o/r", 20)).toBe(diff);
  });

  it("returns oversized patches without caching them or evicting useful warm diffs", async () => {
    const warm = await githubPrDiff("/repo", "o/r", 1);
    const oversized: GithubPrDiff = { ...warm, patch: "界".repeat(2 * 1024 * 1024) };
    mocked.mockResolvedValue(oversized);
    await expect(githubPrDiff("/repo", "o/r", 2)).resolves.toBe(oversized);
    expect(peekGithubPrDiff("o/r", 2)).toBeNull();
    expect(peekGithubPrDiff("o/r", 1)).toBe(warm);
    await githubPrDiff("/repo", "o/r", 2, { maxAgeMs: 30_000 });
    expect(mocked).toHaveBeenCalledTimes(3);
    await githubPrDiff("/repo", "o/r", 1); // Explicit refresh replaces the old small entry.
    expect(peekGithubPrDiff("o/r", 1)).toBeNull();
  });

  it("budgets file-path records as well as patch text and isolates full-context entries", async () => {
    const regular = await githubPrDiff("/repo", "o/r", 1);
    const largeFiles: GithubPrDiff = { ...regular, files: [{ path: "p".repeat(2 * 1024 * 1024), additions: 0, deletions: 0 }] };
    mocked.mockResolvedValueOnce(largeFiles);
    await expect(githubPrDiff("/repo", "o/r", 1, { fullContext: true })).resolves.toBe(largeFiles);
    expect(peekGithubPrDiff("o/r", 1, true)).toBeNull();
    expect(peekGithubPrDiff("o/r", 1)).toBe(regular);
  });

  it("resets byte accounting and ignores late diff results after invalidation", async () => {
    const patch: GithubPrDiff = { additions: 0, deletions: 0, files: [], patch: "x".repeat(512 * 1024), truncated: false };
    mocked.mockResolvedValue(patch);
    for (let number = 1; number <= 15; number += 1) await githubPrDiff("/repo", "o/r", number);
    let resolve!: (value: GithubPrDiff) => void;
    mocked.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = githubPrDiff("/repo", "o/r", 99);
    clearInboxCache();
    resolve(patch);
    await old;
    expect(peekGithubPrDiff("o/r", 99)).toBeNull();
    for (let number = 20; number < 30; number += 1) await githubPrDiff("/repo", "o/r", number);
    expect(Array.from({ length: 10 }, (_, index) => peekGithubPrDiff("o/r", index + 20)).filter(Boolean)).toHaveLength(10);
  });
});
