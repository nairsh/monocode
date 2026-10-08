import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Block } from "../model/session";
import { copyText } from "../../../platform/tauri/clipboard";
import { useTurnState } from "./VirtualTranscriptTurn";

export const RemoteToolDetailContext = createContext<((id: string) => Promise<Block>) | undefined>(undefined);

export function RemoteToolDetail({ block, children }: { block: Block; children: ReactNode }) {
  const load = useContext(RemoteToolDetailContext);
  const [loaded, setLoaded] = useState<{ block: Block; revision?: number }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useTurnState(`remote-output:${block.id}`, false);
  const [fetched, setFetched] = useTurnState(`remote-loaded:${block.id}`, false);
  const generation = useRef(0);
  const version = useRef(block.remoteDetail?.revision);
  if (block.remoteDetail && version.current !== block.remoteDetail.revision) {
    generation.current++;
    version.current = block.remoteDetail.revision;
  }
  useEffect(() => {
    if (block.remoteDetail) { setLoaded(undefined); setFetched(false); setExpanded(false); setPending(false); setError(undefined); }
  }, [block.id, block.remoteDetail?.revision]);
  useEffect(() => () => { generation.current++; }, []);
  const resolved = (!block.remoteDetail && fetched) ||
    (loaded?.block.id === block.id && (!block.remoteDetail || loaded.revision === block.remoteDetail.revision));
  const actual = block.remoteDetail && resolved ? loaded!.block : block;
  const output = actual.tool?.detail || actual.tool?.preview?.output || actual.text;
  if (!block.remoteDetail && !fetched) return children;
  return <div className="flex min-w-0 flex-col gap-1">
    {resolved && expanded ? <span className="text-sm text-content/70">{block.tool?.title ?? "Tool output"}</span> : children}
    {resolved ? <>
      <button type="button" className="self-start text-xs text-content/60" onClick={() => {
        void copyText(output).catch((cause) => setError(String(cause)));
      }}>Copy full output</button>
      <button type="button" className="self-start text-xs text-content/60" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Hide full output" : "Show full output"}
      </button>
      {expanded ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{output}</pre> : null}
    </> : <button type="button" disabled={pending || !load}
      className="self-start text-xs text-content/60" onClick={async () => {
        if (!load) return;
        const token = generation.current;
        const revision = block.remoteDetail?.revision;
        setPending(true); setError(undefined);
        try { const full = await load(block.id); if (token === generation.current) {
          setLoaded({ block: full, revision }); setFetched(true); setExpanded(true);
        } }
        catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { if (token === generation.current) setPending(false); }
      }}>{pending ? "Loading full output…" : "Load full output"}</button>}
    {error ? <span role="alert" className="text-xs text-red-400">{error}</span> : null}
  </div>;
}
