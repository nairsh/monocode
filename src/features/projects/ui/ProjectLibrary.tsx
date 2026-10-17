import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  ARTIFACTS_CHANGED_EVENT,
  getArtifact,
  saveArtifact,
  type Artifact,
  type ArtifactCard,
} from "../../artifacts/artifacts";
import { File, Folder, Plus, Search } from "../../../shared/ui/icons";

export function ProjectLibrary({
  monoId,
  sessionId,
  cwd,
  documents,
  onOpen,
}: {
  monoId: string;
  sessionId: string;
  cwd: string;
  documents: readonly ArtifactCard[];
  onOpen: (id: string) => void;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    localStorage.getItem(`monocode.library.${monoId}.layout`) === "list"
      ? "list"
      : "grid",
  );
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const files = useRef<HTMLInputElement>(null);
  const folders = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void invoke<Artifact[]>("artifacts_list")
        .then((values) => {
          if (active) {
            setArtifacts(
              values.filter((value) => value.sourceSessionId === sessionId),
            );
            setError("");
          }
        })
        .catch((cause) => {
          if (active) setError(String(cause));
        });
    };
    refresh();
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
    };
  }, [sessionId]);
  const all = new Map<string, ArtifactCard & { body?: string }>(
    documents.map((card) => [card.id, card]),
  );
  artifacts.forEach((artifact) => all.set(artifact.id, artifact));
  const cards = [...all.values()].filter(
    (card) =>
      `${card.title} ${card.body ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" || card.kind === filter),
  );
  const inFolder = cards.filter((card) => card.title.startsWith(folder));
  const childFolders = new Set(
    inFolder.flatMap((card) => {
      const rest = card.title.slice(folder.length);
      return rest.includes("/") ? [rest.slice(0, rest.indexOf("/") + 1)] : [];
    }),
  );
  const visible = query
    ? cards
    : inFolder.filter((card) => !card.title.slice(folder.length).includes("/"));
  const save = async (
    title: string,
    body: string,
    kind: "document" | "html",
  ) => {
    const artifact = await saveArtifact({
      id: `project-${crypto.randomUUID()}`,
      title,
      body,
      kind,
      sourceSessionId: sessionId,
      sourceCwd: cwd,
    });
    setArtifacts((current) => [...current, artifact]);
  };
  const importFiles = async (selection: FileList | null) => {
    if (!selection?.length) return;
    setBusy(true);
    setError("");
    let count = 0;
    try {
      for (const file of Array.from(selection)) {
        if (
          file.size > 2_000_000 ||
          !/\.(md|markdown|txt|html?|json|csv|ya?ml|log|css|[cm]?[jt]sx?)$/i.test(
            file.name,
          )
        )
          throw new Error(
            `Imported ${count} files. ${file.name} is unsupported: choose text files under 2 MB.`,
          );
        await save(
          file.webkitRelativePath || file.name,
          await file.text(),
          /\.html?$/i.test(file.name) ? "html" : "document",
        );
        count++;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      if (files.current) files.current.value = "";
      if (folders.current) folders.current.value = "";
    }
  };
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      await save(title.trim(), body, "document");
      setAdding(false);
      setTitle("");
      setBody("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-project-library className="flex flex-col gap-3 p-1 text-[12px]">
      <div className="flex items-center gap-2">
        <Search className="size-3.5 text-content/40" />
        <input
          aria-label="Search library"
          className="min-w-0 flex-1 bg-transparent p-1 outline-none"
          placeholder="Search library"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Library type"
          className="max-w-28 rounded bg-content/5 p-1"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All types</option>
          <option value="document">Documents</option>
          <option value="html">HTML artifacts</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          aria-label="Add document"
          className="flex items-center gap-1 rounded bg-content/8 px-2 py-1.5"
          onClick={() => setAdding(!adding)}
        >
          <Plus className="size-3" />
          Add
        </button>
        <button disabled={busy} onClick={() => files.current?.click()}>
          Files
        </button>
        <button disabled={busy} onClick={() => folders.current?.click()}>
          Folder
        </button>
        <button
          className="ml-auto rounded px-2 py-1"
          aria-label={`Switch to ${layout === "grid" ? "list" : "grid"} view`}
          onClick={() => {
            const next = layout === "grid" ? "list" : "grid";
            setLayout(next);
            localStorage.setItem(`monocode.library.${monoId}.layout`, next);
          }}
        >
          {layout === "grid" ? "List" : "Grid"}
        </button>
      </div>
      <input
        ref={files}
        type="file"
        aria-label="Import library files"
        multiple
        accept=".md,.txt,.html,.htm,.json,.csv,.yaml,.yml,.css,.js,.ts,.tsx"
        hidden
        onChange={(event) => void importFiles(event.target.files)}
      />
      <input
        ref={folders}
        type="file"
        aria-label="Import library folder"
        multiple
        {...{ webkitdirectory: "" }}
        hidden
        onChange={(event) => void importFiles(event.target.files)}
      />
      {adding ? (
        <form
          className="flex flex-col gap-2 rounded-lg border border-stroke p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            aria-label="Document title"
            placeholder="Document title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={300}
            className="bg-transparent p-1 outline-none"
          />
          <textarea
            aria-label="Document content"
            placeholder="Write a document…"
            rows={6}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="rounded border border-stroke bg-transparent p-2 outline-none"
          />
          <button
            disabled={!title.trim() || busy}
            className="self-end rounded bg-content/10 px-3 py-1.5"
          >
            {busy ? "Saving…" : "Save document"}
          </button>
        </form>
      ) : null}
      {folder && !query ? (
        <button
          className="text-left text-content/55"
          onClick={() => setFolder(folder.replace(/[^/]+\/$/, ""))}
        >
          ← {folder}
        </button>
      ) : null}
      {busy ? <p role="status">Saving to the project library…</p> : null}
      {error ? (
        <p role="alert" className="text-red-400">
          {error}
        </p>
      ) : null}
      <div
        className={
          layout === "grid"
            ? "grid grid-cols-2 gap-2 @max-sm:grid-cols-1"
            : "flex flex-col gap-1"
        }
      >
        {!query
          ? [...childFolders].map((name) => (
              <button
                key={name}
                className="flex items-center gap-2 rounded-lg border border-stroke p-3 text-left hover:bg-content/5"
                onClick={() => setFolder(folder + name)}
              >
                <Folder className="size-4 shrink-0" />
                <span className="truncate">{name.slice(0, -1)}</span>
              </button>
            ))
          : null}
        {visible.map((card) => (
          <button
            key={card.id}
            className={`flex min-w-0 gap-2 rounded-lg border border-stroke text-left hover:bg-content/5 ${layout === "grid" ? "min-h-24 flex-col p-3" : "items-center px-3 py-2"}`}
            onClick={() => {
              void getArtifact(card.id)
                .then((value) => {
                  if (!value)
                    throw new Error("Document is no longer available.");
                  onOpen(card.id);
                })
                .catch((cause) => setError(String(cause)));
            }}
          >
            <File className="size-4 shrink-0 text-content/50" />
            <span className="line-clamp-2 break-words">
              {query ? card.title : card.title.slice(folder.length)}
            </span>
            <span className="text-[10px] text-content/40">
              {card.kind === "html" ? "HTML artifact" : "Document"}
            </span>
          </button>
        ))}
      </div>
      {!cards.length ? (
        <p className="py-10 text-center text-content/40">
          {query
            ? "No matching documents"
            : "Add files, folders, or a document. Artifacts created by the coordinator appear here."}
        </p>
      ) : null}
    </div>
  );
}
