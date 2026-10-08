import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import type { HostSession } from "../src/features/connections/model/protocol";
import { applySessionSync } from "../src/features/connections/model/protocol";
import { projectHostBlock } from "./session-projection";

const cleanups: (() => void)[] = [];
function recordPerformance(name: string, metrics: Record<string, number>) {
  const directory = process.env.MONOCODE_PERF_OUTPUT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), JSON.stringify(metrics, null, 2) + "\n");
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "host-store-"));
  const path = join(dir, "host.db");
  const store = new HostStore(path);
  const project = store.addProject(dir, "Project");
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const value: HostSession = { projectId: project.id, revision: 1, status: "idle", updatedAt: 1,
    session: { id: "session", harness: "codex", model: "codex:test", runtimeMode: "supervised", cwd: dir, title: "Chat",
      blocks: Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: "assistant", text: "x".repeat(8192) })) } };
  const save = (input: HostSession, event: unknown = {}) => store.transaction(() => store.save(input, event));
  return { store, path, value, save };
}

it("writes only the changed block and recovers ordered blocks after reopening", () => {
  const { store, path, value, save } = setup();
  const first = save(value);
  store.db.exec("CREATE TABLE writes (id TEXT); CREATE TRIGGER count_block_updates AFTER UPDATE ON session_blocks BEGIN INSERT INTO writes VALUES (NEW.id); END;");
  const blocks = first.session.blocks.slice();
  blocks[99] = { ...blocks[99], text: "changed 🚀" };
  const next = save({ ...first, revision: 2, session: { ...first.session, blocks } });
  const writes = store.db.prepare("SELECT id FROM writes").all();
  expect(writes).toEqual([{ id: "99" }]);
  const metadata = String(store.db.prepare("SELECT snapshot FROM sessions").get()!.snapshot);
  recordPerformance("perf-host-persistence.json", {
    changedBlockRows: writes.length,
    persistedMetadataBytes: Buffer.byteLength(metadata),
    fullSnapshotBytes: Buffer.byteLength(JSON.stringify(first)),
  });
  expect(Buffer.byteLength(metadata)).toBeLessThan(10_000);
  expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(800_000);
  const reopened = new HostStore(path);
  try { expect(reopened.session("session")).toEqual(next); } finally { reopened.close(); }
  const removed = save({ ...next, revision: 3, session: { ...next.session, blocks: blocks.slice(1).reverse() } });
  expect(store.db.prepare("SELECT id FROM session_blocks WHERE id='0'").get()).toBeUndefined();
  const again = new HostStore(path);
  try { expect(again.session("session")).toEqual(removed); } finally { again.close(); }
});

it("rolls back block updates with the revision and migrates legacy inline snapshots", () => {
  const { store, value, save } = setup();
  store.db.prepare("INSERT INTO sessions (id, project_id, snapshot) VALUES (?, ?, ?)").run(value.session.id, value.projectId, JSON.stringify(value));
  expect(store.session("session")).toEqual(value);
  const migrated = save({ ...value, revision: 2 });
  expect(store.db.prepare("SELECT count(*) AS count FROM session_blocks").get()!.count).toBe(100);
  expect(() => store.transaction(() => {
    store.save({ ...migrated, revision: 3, session: { ...migrated.session, blocks: [] } }, {});
    throw new Error("abort");
  })).toThrow("abort");
  expect(store.session("session")).toEqual(migrated);
  store.deleteSession("session");
  expect(store.db.prepare("SELECT count(*) AS count FROM session_blocks").get()!.count).toBe(0);
});

it("commits the durable format upgrade atomically and rejects unknown future formats before changing schema", () => {
  const { store, path, value, save } = setup();
  store.db.prepare("INSERT INTO sessions (id, project_id, snapshot) VALUES (?, ?, ?)").run(value.session.id, value.projectId, JSON.stringify(value));
  expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(0);
  expect(() => store.transaction(() => {
    store.save({ ...value, revision: 2 }, {});
    expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    throw new Error("abort migration");
  })).toThrow("abort migration");
  expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(0);
  expect(store.db.prepare("SELECT count(*) AS count FROM session_blocks").get()!.count).toBe(0);
  expect(store.session("session")).toEqual(value);
  const migrated = save({ ...value, revision: 2 });
  expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
  const current = new HostStore(path);
  try { expect(current.session("session")).toEqual(migrated); } finally { current.close(); }
  store.db.exec("PRAGMA user_version=2; DROP INDEX session_block_history");
  expect(() => new HostStore(path)).toThrow("database format 2 is newer");
  expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='session_block_history'").get()).toBeUndefined();
});

it("recovers through a snapshot before parsing oversized replay payloads", () => {
  const { store, value, save } = setup();
  save(value, { text: "x".repeat(8 * 1024 * 1024) });
  expect(store.events("session", 0).snapshot?.revision).toBe(1);
  expect(store.events("session", 1).events).toEqual([]);
});

it("bounds history with no user-turn boundaries and preserves older block access", () => {
  const { store, value, save } = setup();
  save(value);
  const initial = applySessionSync(undefined, store.sync("session", undefined, { projected: true }));
  expect(initial.session.blocks).toHaveLength(75);
  expect(initial.historyBefore).toBe("25");
  const expanded = applySessionSync(initial, store.sync("session", 1, { projected: true, startBlockId: "25", earlier: true }));
  expect(expanded.session.blocks).toHaveLength(100);
  expect(expanded.historyBefore).toBeNull();
  const orderedPlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT id, payload FROM session_blocks WHERE session_id=? ORDER BY position").all("session").map((row) => String(row.detail)).join(" ");
  expect(orderedPlan).toContain("session_block_order");
  expect(orderedPlan).not.toContain("TEMP B-TREE");
  const turnPlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT position FROM session_blocks WHERE session_id=? AND role='user' AND position<? ORDER BY position DESC LIMIT 1 OFFSET 19").all("session", 100).map((row) => String(row.detail)).join(" ");
  expect(turnPlan).toContain("session_block_history");
  expect(turnPlan).not.toContain("TEMP B-TREE");
});

it("keeps live tools and approvals complete while preserving failed-tool indicators", () => {
  const tool = { id: "tool", role: "tool" as const, text: "x".repeat(100_000), tool: { title: "Command", status: "completed" } };
  const streaming = { ...tool, streaming: true };
  const approval = { ...tool, approval: { requestId: 1 } };
  expect(projectHostBlock(streaming, 1)).toBe(streaming);
  expect(projectHostBlock(approval, 1)).toBe(approval);
  const failed = projectHostBlock({ ...tool, tool: { ...tool.tool, status: "failed" } }, 2);
  expect(failed.tool?.status).toBe("failed");
  expect(failed.remoteDetail?.revision).toBe(2);
});

it("notifies revision subscribers only after commit, handles deletion, and releases cancelled waits", async () => {
  const { store, value, save } = setup();
  const first = save(value);
  const controller = new AbortController();
  const waiting = store.waitForRevisions([{ sessionId: "session", revision: 1 }], controller.signal);
  let delivered = false;
  void waiting.then(() => { delivered = true; });
  expect(() => store.transaction(() => {
    store.save({ ...first, revision: 2 }, {});
    throw new Error("abort");
  })).toThrow("abort");
  await Promise.resolve();
  expect(delivered).toBe(false);
  save({ ...first, revision: 2 });
  expect(await waiting).toEqual({ session: 2 });
  const deleted = store.waitForRevisions([{ sessionId: "session", revision: 2 }]);
  store.deleteSession("session");
  expect(await deleted).toEqual({ session: null });
  const cancelled = new AbortController();
  const current = store.waitForRevisions([{ sessionId: "session", revision: 0 }], cancelled.signal);
  expect(await current).toEqual({ session: null });
  save(first);
  const stopped = store.waitForRevisions([{ sessionId: "session", revision: 1 }], cancelled.signal);
  cancelled.abort();
  expect(await stopped).toEqual({});
});

it("loads recent turns and older pages from disk, projects completed tools, and preserves full searchable output", () => {
  const { store, path, value, save } = setup();
  const blocks = Array.from({ length: 60 }, (_, i) => [
    { id: `user-${i}`, role: "user" as const, text: `Question ${i}` },
    { id: `tool-${i}`, role: "tool" as const, text: "🚀".repeat(40_000) + ` needle-${i}`,
      tool: { title: "Command", status: "completed", detail: "result", preview: { kind: "shell" as const, output: "x".repeat(100_000) } } },
  ]).flat();
  const first = save({ ...value, session: { ...value.session, blocks } });
  const cold = new HostStore(path);
  try {
    const projected = applySessionSync(undefined, cold.sync("session", undefined, { projected: true }));
    expect(projected.session.blocks).toHaveLength(40);
    expect(projected.historyBefore).toBe("user-40");
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(150_000);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(10_000_000);
    expect(projected.session.blocks[1].remoteDetail).toMatchObject({ revision: 1 });
    const expanded = applySessionSync(projected, cold.sync("session", 1, { projected: true, startBlockId: "user-40", earlier: true }));
    expect(expanded.session.blocks).toHaveLength(80);
    expect(expanded.historyBefore).toBe("user-20");
    expect(expanded.session.blocks[40]).toBe(projected.session.blocks[0]);
    expect(cold.searchBlocks("session", "needle-0")).toEqual(["tool-0"]);
    expect(cold.searchBlocks("session", "🚀")).toHaveLength(60);
    const detail = cold.blockDetail("session", "tool-0", 1);
    if (detail.kind !== "snapshot") throw new Error("Expected detail snapshot");
    expect(detail.value.session.blocks[0]).toEqual(blocks[1]);
    const complete = applySessionSync(expanded, cold.sync("session", 1, { projected: true, startBlockId: "user-20", all: true }));
    expect(complete.historyBefore).toBeNull();
    expect(complete.session.blocks).toHaveLength(120);
  } finally { cold.close(); }
  const changed = blocks.slice();
  changed[1] = { ...changed[1], text: "new output" };
  save({ ...first, revision: 2, session: { ...first.session, blocks: changed } });
  expect(() => store.blockDetail("session", "tool-0", 1)).toThrow("changed");
});
