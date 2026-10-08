import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  CommandReceipt,
  HostProject,
  HostSession,
  HostSessionSummary,
  RemoteProvider,
  SessionSync,
} from "../src/features/connections/model/protocol";
import type { LinkedWorkItem } from "../src/features/sessions/model/session";
import { sessionNeedsInput } from "../src/features/sessions/model/session";
import { projectHostBlock } from "./session-projection";
import type { Block } from "../src/features/sessions/model/session";

const CACHED_SESSIONS = 32;
const CACHE_BYTES = 32 * 1024 * 1024;
const REPLAY_ITEMS = 1_000;
const REPLAY_BYTES = 8 * 1024 * 1024;
// Version 0 contains legacy inline snapshots. Version 1 permits normalized
// block rows and requires a host that can reconstruct them. Restoring a
// pre-upgrade backup is the supported path to an older host binary.
const STORE_FORMAT_VERSION = 1;

export class HostStore {
  readonly db: DatabaseSync;
  readonly environmentId: string;
  readonly attachmentDir: string;
  // This process is the only session writer, so recently used snapshots are
  // served from memory instead of re-parsing whole transcripts. Callers must
  // treat returned values as immutable.
  private cache = new Map<string, HostSession>();
  private cacheSizes = new Map<string, number>();
  private blockSizes = new WeakMap<object, number>();
  private changes = new Set<string>();
  private listeners = new Set<() => void>();
  private inTransaction = false;

  constructor(path: string) {
    this.attachmentDir = join(dirname(path), "attachments");
    this.db = new DatabaseSync(path);
    const format = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
    if (format > STORE_FORMAT_VERSION) {
      this.db.close();
      throw new Error(`Host database format ${format} is newer than this host supports (${STORE_FORMAT_VERSION}). Use a newer host or restore a compatible backup.`);
    }
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_blocks (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, payload TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT '', PRIMARY KEY(session_id, id));
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, signature TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL REFERENCES sessions(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id, revision));
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);`);
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
    if (!columns.some((column) => column.name === "summary"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT");
    const blockColumns = this.db.prepare("PRAGMA table_info(session_blocks)").all();
    if (!blockColumns.some((column) => column.name === "position")) {
      this.db.exec("ALTER TABLE session_blocks ADD COLUMN position INTEGER NOT NULL DEFAULT 0; ALTER TABLE session_blocks ADD COLUMN role TEXT NOT NULL DEFAULT ''");
      for (const row of this.db.prepare("SELECT id, snapshot FROM sessions").all()) {
        const snapshot = JSON.parse(String(row.snapshot)) as { storedBlockIds?: string[] };
        for (const [position, id] of (snapshot.storedBlockIds ?? []).entries())
          this.db.prepare("UPDATE session_blocks SET position=?, role=json_extract(payload, '$.role') WHERE session_id=? AND id=?").run(position, row.id, id);
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS session_block_history ON session_blocks(session_id, role, position)");
    this.db.exec("CREATE INDEX IF NOT EXISTS session_block_order ON session_blocks(session_id, position)");
    this.db
      .prepare("INSERT OR IGNORE INTO metadata VALUES ('environmentId', ?)")
      .run(randomUUID());
    this.environmentId = String(
      this.db
        .prepare("SELECT value FROM metadata WHERE key='environmentId'")
        .get()!.value,
    );
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    let value: T;
    try {
      value = fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.cache.clear();
      this.cacheSizes.clear();
      this.changes.clear();
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        console.error("Could not roll back host transaction:", rollbackError);
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
    if (this.changes.size) {
      this.changes.clear();
      for (const listener of this.listeners) listener();
    }
    return value;
  }

  project(id: string): HostProject {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id);
    if (!row) throw new Error("Project is not registered on this machine");
    return row as unknown as HostProject;
  }

  /** One bounded revision wait per machine; no transcript/event queues. */
  waitForRevisions(cursors: { sessionId: string; revision: number }[], signal?: AbortSignal): Promise<Record<string, number | null>> {
    if (this.listeners.size >= 128) throw new Error("Too many session subscriptions; retry later");
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (changed: Record<string, number | null>) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        signal?.removeEventListener("abort", abort);
        resolve(changed);
      };
      const abort = () => finish({});
      const check = () => {
        const changed: Record<string, number | null> = {};
        for (const cursor of cursors) {
          const row = this.db.prepare("SELECT json_extract(snapshot, '$.revision') AS revision FROM sessions WHERE id=?").get(cursor.sessionId);
          const revision = row ? Number(row.revision) : null;
          if (revision !== cursor.revision) changed[cursor.sessionId] = revision;
        }
        if (Object.keys(changed).length) finish(changed);
      };
      // Register before reading revisions to avoid a replay/live gap.
      this.listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, 20_000);
      timer.unref?.();
      if (signal?.aborted) abort();
      else check();
    });
  }

  projects(): HostProject[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY name")
      .all() as unknown as HostProject[];
  }

  addProject(cwd: string, name: string): HostProject {
    this.db
      .prepare("INSERT OR IGNORE INTO projects VALUES (?, ?, ?)")
      .run(randomUUID(), cwd, name);
    return this.db
      .prepare("SELECT * FROM projects WHERE cwd=?")
      .get(cwd) as unknown as HostProject;
  }

  private remember(value: HostSession): HostSession {
    let size = 0;
    for (const block of value.session.blocks) {
      let bytes = this.blockSizes.get(block);
      if (bytes === undefined) {
        bytes = Buffer.byteLength(JSON.stringify(block));
        this.blockSizes.set(block, bytes);
      }
      size += bytes;
    }
    this.cache.delete(value.session.id);
    this.cacheSizes.delete(value.session.id);
    if (size <= CACHE_BYTES) {
      this.cache.set(value.session.id, value);
      this.cacheSizes.set(value.session.id, size);
    }
    let total = [...this.cacheSizes.values()].reduce((a, b) => a + b, 0);
    while (this.cache.size > CACHED_SESSIONS || total > CACHE_BYTES) {
      const id = this.cache.keys().next().value!;
      total -= this.cacheSizes.get(id) ?? 0;
      this.cache.delete(id);
      this.cacheSizes.delete(id);
    }
    return value;
  }

  private decode(snapshot: string): HostSession {
    const stored = JSON.parse(snapshot) as HostSession & { storedBlockIds?: string[] };
    if (!stored.storedBlockIds) return stored;
    const { storedBlockIds, ...value } = stored;
    const blocks = new Map(this.db.prepare(
      "SELECT id, payload FROM session_blocks WHERE session_id=?",
    ).all(value.session.id).map((row) => [String(row.id), String(row.payload)]));
    return { ...value, session: { ...value.session, blocks: storedBlockIds.map((id) => {
      const payload = blocks.get(id);
      if (payload === undefined) throw new Error("Stored session is missing a block");
      return JSON.parse(payload);
    }) } };
  }

  private find(id: string): HostSession | undefined {
    const cached = this.cache.get(id);
    if (cached) {
      this.cache.delete(id);
      this.cache.set(id, cached);
      return cached;
    }
    const row = this.db
      .prepare("SELECT snapshot FROM sessions WHERE id=?")
      .get(id);
    return row
      ? this.remember(this.decode(String(row.snapshot)))
      : undefined;
  }

  session(id: string): HostSession {
    const value = this.find(id);
    if (!value) throw new Error("Session not found on this machine");
    return value;
  }

  summaries(projectId: string): HostSessionSummary[] {
    return this.db
      .prepare("SELECT id, summary FROM sessions WHERE project_id=?")
      .all(projectId)
      .map((row) => {
        const cached = row.summary
          ? (JSON.parse(String(row.summary)) as HostSessionSummary)
          : undefined;
        if (
          cached?.model &&
          cached.needsInput !== undefined &&
          cached.providerSessionId !== undefined
        )
          return cached;
        const fresh = summary(this.session(String(row.id)));
        this.db.prepare("UPDATE sessions SET summary=? WHERE id=?").run(
          JSON.stringify(fresh),
          String(row.id),
        );
        return fresh;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  sync(id: string, revision?: number, options?: { projected?: boolean; startBlockId?: string; earlier?: boolean; all?: boolean; untilBlockId?: string }): SessionSync {
    if (options?.projected) return this.projectedSync(id, revision, options);
    const value = this.session(id);
    const { blockRevisions, ...snapshot } = value;
    if (revision === value.revision) return { kind: "unchanged", revision };
    if (revision === undefined || revision > value.revision || !blockRevisions)
      return { kind: "snapshot", value: snapshot };
    const {
      session: { blocks, ...session },
      ...rest
    } = snapshot;
    return {
      kind: "delta",
      base: revision,
      value: { ...rest, session },
      blockIds: blocks.map((block) => block.id),
      blocks: blocks.filter(
        (block) => (blockRevisions[block.id] ?? value.revision) > revision,
      ),
    };
  }

  private projectedSync(id: string, revision: number | undefined, options: { startBlockId?: string; earlier?: boolean; all?: boolean; untilBlockId?: string }): SessionSync {
    const row = this.db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id);
    if (!row) throw new Error("Session not found on this machine");
    const stored = JSON.parse(String(row.snapshot)) as HostSession & { storedBlockIds?: string[] };
    if (!stored.storedBlockIds) {
      // Legacy inline snapshots remain readable until the next durable write.
      const value = this.session(id);
      if (revision === value.revision) return { kind: "unchanged", revision };
      return { kind: "snapshot", value: { ...value, session: { ...value.session,
        blocks: value.session.blocks.map((block) => projectHostBlock(block, value.blockRevisions?.[block.id] ?? value.revision)) } } };
    }
    if (revision === stored.revision && !options.earlier && !options.all && !options.untilBlockId) return { kind: "unchanged", revision };
    const { storedBlockIds, blockRevisions, ...metadata } = stored;
    const knownStart = options.startBlockId ? storedBlockIds.indexOf(options.startBlockId) : -1;
    const end = options.earlier && knownStart >= 0 ? knownStart : storedBlockIds.length;
    const turn = this.db.prepare("SELECT position FROM session_blocks WHERE session_id=? AND role='user' AND position<? ORDER BY position DESC LIMIT 1 OFFSET 19").get(id, end);
    let pageStart = Number(turn?.position ?? 0);
    if (!turn && !this.db.prepare("SELECT 1 FROM session_blocks WHERE session_id=? AND role='user' AND position<? LIMIT 1").get(id, end)) {
      // Histories without user boundaries use item/byte budgets. Normal turns
      // stay intact; a single oversized item remains accessible via chunking.
      let bytes = 0;
      let count = 0;
      for (const row of this.db.prepare("SELECT position, length(CAST(payload AS BLOB)) AS bytes FROM session_blocks WHERE session_id=? AND position<? ORDER BY position DESC LIMIT 75").iterate(id, end)) {
        if (count && bytes + Number(row.bytes) > 1024 * 1024) break;
        bytes += Number(row.bytes);
        count++;
        pageStart = Number(row.position);
      }
    }
    const target = options.untilBlockId ? storedBlockIds.indexOf(options.untilBlockId) : -1;
    if (options.untilBlockId && target < 0) throw new Error("Search result no longer exists");
    const start = options.all ? 0 : target >= 0 ? Math.min(target, knownStart < 0 ? target : knownStart) : options.earlier || knownStart < 0 ? pageStart : knownStart;
    const ids = storedBlockIds.slice(start);
    const snapshot = revision === undefined || revision > stored.revision || !blockRevisions || (options.startBlockId !== undefined && knownStart < 0);
    const selected = snapshot ? ids : ids.filter((blockId, index) => start + index < knownStart || (blockRevisions[blockId] ?? stored.revision) > revision!);
    const blocks = this.db.prepare("SELECT id, payload FROM session_blocks WHERE session_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY position").all(id, JSON.stringify(selected))
      .map((row) => projectHostBlock(JSON.parse(String(row.payload)) as Block, blockRevisions?.[String(row.id)] ?? stored.revision));
    const value = { ...metadata, historyBefore: start > 0 ? ids[0] : null };
    if (snapshot) return { kind: "snapshot", value: { ...value, session: { ...value.session, blocks } } };
    const { blocks: _, ...session } = value.session;
    return { kind: "delta", base: revision!, value: { ...value, session }, blockIds: ids, blocks };
  }

  blockDetail(id: string, blockId: string, revision: number): SessionSync {
    const row = this.db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id);
    if (!row) throw new Error("Session not found on this machine");
    const stored = JSON.parse(String(row.snapshot)) as HostSession & { storedBlockIds?: string[] };
    if ((stored.blockRevisions?.[blockId] ?? stored.revision) !== revision)
      throw new Error("Tool output changed; reload the session before retrying");
    const payload = this.db.prepare("SELECT payload FROM session_blocks WHERE session_id=? AND id=?").get(id, blockId);
    const block = payload ? JSON.parse(String(payload.payload)) as Block : this.session(id).session.blocks.find((block) => block.id === blockId);
    if (!block) throw new Error("Tool output no longer exists");
    const { storedBlockIds: _, blockRevisions: __, ...value } = stored;
    return { kind: "snapshot", value: { ...value, session: { ...value.session, blocks: [block] } } };
  }

  searchBlocks(id: string, query: string): string[] {
    const row = this.db.prepare("SELECT snapshot FROM sessions WHERE id=?").get(id);
    if (!row) throw new Error("Session not found on this machine");
    const stored = JSON.parse(String(row.snapshot)) as { storedBlockIds?: string[] };
    const match = (block: Block) => [block.text, block.tool?.detail, block.tool?.preview?.output,
      ...(block.tool?.preview?.lines?.map((line) => line.text) ?? [])].some((text) => text?.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (!stored.storedBlockIds) return this.session(id).session.blocks.filter(match).slice(0, 1_000).map((block) => block.id);
    const found: string[] = [];
    // Search is explicitly requested, not part of a stream update. SQLite's
    // iterator bounds retention to one row; Unicode matching stays in JS.
    for (const row of this.db.prepare("SELECT id, payload FROM session_blocks WHERE session_id=? ORDER BY position").iterate(id)) {
      if (match(JSON.parse(String(row.payload)) as Block)) found.push(String(row.id));
      if (found.length === 1_000) break;
    }
    return found;
  }

  sessions(projectId?: string): HostSession[] {
    const rows = projectId
      ? this.db
          .prepare("SELECT snapshot FROM sessions WHERE project_id=?")
          .all(projectId)
      : this.db.prepare("SELECT snapshot FROM sessions").all();
    return rows
      .map((row) => this.decode(String(row.snapshot)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Startup needs bindings and interrupted IDs, not every settled transcript. */
  startupBindings(): { id: string; status: string; harness: string; cwd: string; providerSessionId?: string }[] {
    return this.db.prepare(`SELECT id, json_extract(snapshot, '$.status') AS status,
      json_extract(snapshot, '$.session.harness') AS harness,
      json_extract(snapshot, '$.session.cwd') AS cwd,
      json_extract(snapshot, '$.session.providerSessionId') AS providerSessionId FROM sessions`)
      .all().map((row) => ({ id: String(row.id), status: String(row.status), harness: String(row.harness), cwd: String(row.cwd),
        ...(row.providerSessionId ? { providerSessionId: String(row.providerSessionId) } : {}) }));
  }

  /** Returns the saved value, stamped with per-block change revisions. */
  save(input: HostSession, event: unknown): HostSession {
    if (!this.inTransaction) return this.transaction(() => this.save(input, event));
    const previous = this.find(input.session.id);
    const value = {
      ...input,
      // Older snapshots have no creation time. Preserve their last recorded
      // timestamp when they are first written by this version of the host.
      createdAt:
        input.createdAt ?? previous?.createdAt ?? previous?.updatedAt ?? input.updatedAt,
      blockRevisions: blockRevisions(previous, input),
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, snapshot, summary) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot, summary=excluded.summary",
      )
      .run(
        value.session.id,
        value.projectId,
        JSON.stringify({ ...value, session: { ...value.session, blocks: [] }, storedBlockIds: value.session.blocks.map((block) => block.id) }),
        JSON.stringify(summary(value)),
      );
    const writeBlock = this.db.prepare(
      "INSERT INTO session_blocks (session_id, id, payload, position, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, id) DO UPDATE SET payload=excluded.payload, position=excluded.position, role=excluded.role",
    );
    // Old inline snapshots migrate on their next write. Only changed blocks
    // are serialized after that, in the same transaction as metadata/events.
    const stored = new Set(this.db.prepare("SELECT id FROM session_blocks WHERE session_id=?")
      .all(value.session.id).map((row) => String(row.id)));
    const beforePositions = new Map(previous?.session.blocks.map((block, index) => [block.id, index]));
    for (const [position, block] of value.session.blocks.entries()) {
      if (!stored.has(block.id) || value.blockRevisions[block.id] === value.revision) {
        const payload = JSON.stringify(block);
        writeBlock.run(value.session.id, block.id, payload, position, block.role);
        this.blockSizes.set(block, Buffer.byteLength(payload));
      }
      else if (beforePositions.get(block.id) !== position)
        this.db.prepare("UPDATE session_blocks SET position=? WHERE session_id=? AND id=?").run(position, value.session.id, block.id);
      stored.delete(block.id);
    }
    for (const id of stored)
      this.db.prepare("DELETE FROM session_blocks WHERE session_id=? AND id=?").run(value.session.id, id);
    this.db
      .prepare("INSERT INTO events VALUES (?, ?, ?)")
      .run(value.session.id, value.revision, JSON.stringify(event));
    this.db
      .prepare("DELETE FROM events WHERE session_id=? AND revision<?")
      .run(value.session.id, value.revision - 2_000);
    // The marker commits with the first normalized snapshot and its block
    // rows; failed writes leave both the old format and old data intact.
    this.db.exec(`PRAGMA user_version=${STORE_FORMAT_VERSION}`);
    this.changes.add(value.session.id);
    return this.remember(value);
  }

  updateSession(
    id: string,
    patch: { title?: string; archived?: boolean; pinned?: boolean; linkedWorkItem?: LinkedWorkItem | null },
  ): HostSessionSummary {
    return this.transaction(() => {
      const current = this.session(id);
      if (patch.title !== undefined && (!patch.title.trim() || patch.title.length > 200))
        throw new Error("Invalid session title");
      const next = this.save(
        {
          ...current,
          revision: current.revision + 1,
          archived: patch.archived ?? current.archived,
          pinned: patch.pinned ?? current.pinned,
          session: {
            ...current.session,
            ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
            ...(patch.linkedWorkItem === undefined
              ? {}
              : { linkedWorkItem: patch.linkedWorkItem ?? undefined }),
          },
        },
        { type: "session.metadata", patch },
      );
      return summary(next);
    });
  }

  deleteSession(id: string): void {
    this.transaction(() => {
      const current = this.session(id);
      if (current.status === "running")
        throw new Error("Stop this session before deleting it");
      this.db.prepare("DELETE FROM events WHERE session_id=?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
      this.cache.delete(id);
      this.cacheSizes.delete(id);
      this.changes.add(id);
    });
  }

  receipt(id: string, signature: string): CommandReceipt | undefined {
    const row = this.db.prepare("SELECT * FROM receipts WHERE id=?").get(id);
    if (!row) return undefined;
    if (row.signature !== signature)
      throw new Error("Command ID was already used with a different payload");
    return JSON.parse(String(row.receipt)) as CommandReceipt;
  }

  recordReceipt(signature: string, receipt: CommandReceipt): void {
    this.db
      .prepare("INSERT INTO receipts VALUES (?, ?, ?)")
      .run(receipt.commandId, signature, JSON.stringify(receipt));
  }

  events(
    id: string,
    after: number,
  ): { snapshot?: HostSession; events?: unknown[]; revision: number } {
    const snapshot = this.session(id);
    const rows = this.db
      .prepare(
        "SELECT revision, length(CAST(payload AS BLOB)) AS bytes FROM events WHERE session_id=? AND revision>? ORDER BY revision LIMIT ?",
      )
      .all(id, after, REPLAY_ITEMS + 1);
    if (
      after > snapshot.revision ||
      rows.length > REPLAY_ITEMS ||
      rows.reduce((total, row) => total + Number(row.bytes), 0) > REPLAY_BYTES ||
      (after < snapshot.revision && Number(rows[0]?.revision) !== after + 1)
    ) {
      return { snapshot, revision: snapshot.revision };
    }
    return {
      events: this.db.prepare(
        "SELECT revision, payload FROM events WHERE session_id=? AND revision>? ORDER BY revision LIMIT ?",
      ).all(id, after, REPLAY_ITEMS).map((row) => ({
        revision: row.revision,
        event: JSON.parse(String(row.payload)),
      })),
      revision: snapshot.revision,
    };
  }

  issueDevice(name: string): { id: string; token: string } {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO devices VALUES (?, ?, ?)")
      .run(id, name, this.hash(token));
    return { id, token };
  }

  revokeDevice(id: string): boolean {
    return (
      Number(
        this.db.prepare("DELETE FROM devices WHERE id=?").run(id).changes,
      ) > 0
    );
  }

  /** Lets a desktop revoke only the credential it is using. */
  revokeToken(token: string): boolean {
    return (
      Number(
        this.db
          .prepare("DELETE FROM devices WHERE hash=?")
          .run(this.hash(token)).changes,
      ) > 0
    );
  }

  authenticated(token: string): boolean {
    return !!this.db
      .prepare("SELECT id FROM devices WHERE hash=?")
      .get(this.hash(token));
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
  close(): void {
    this.db.close();
  }
}

export function summary(value: HostSession): HostSessionSummary {
  return {
    projectId: value.projectId,
    revision: value.revision,
    runId: value.runId,
    status: value.status,
    updatedAt: value.updatedAt,
    id: value.session.id,
    cwd: value.session.cwd,
    title: value.session.title,
    harness: value.session.harness as RemoteProvider,
    model: value.session.model,
    runtimeMode: value.session.runtimeMode,
    providerSessionId: value.session.providerSessionId ?? null,
    createdAt: value.createdAt ?? value.updatedAt,
    archived: value.archived,
    pinned: value.pinned,
    linkedWorkItem: value.session.linkedWorkItem,
    needsInput: sessionNeedsInput(value.session),
    draft: value.session.blocks.some((block) => block.role === "user" && block.draft),
  };
}

/** Unchanged blocks keep their previous stamp. Identity is the fast path;
 * values re-read from disk fall back to a structural comparison. */
export function blockRevisions(
  previous: HostSession | undefined,
  next: HostSession,
): Record<string, number> {
  const before = new Map(
    previous?.session.blocks.map((block) => [block.id, block]),
  );
  const revisions: Record<string, number> = {};
  for (const block of next.session.blocks) {
    const old = before.get(block.id);
    const stamp = previous?.blockRevisions?.[block.id];
    revisions[block.id] =
      old &&
      stamp !== undefined &&
      (old === block || JSON.stringify(old) === JSON.stringify(block))
        ? stamp
        : next.revision;
  }
  return revisions;
}
