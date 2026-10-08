import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentTranscript } from "../src/features/sessions/ui/AgentTranscript";
import type { Block } from "../src/features/sessions/model/session";
import "../src/styles/index.css";

const blocks: Block[] = Array.from({ length: 2000 }, (_, index): Block[] => [
  { id: `u${index}`, role: "user", text: `Question ${index}: inspect this realistic long transcript.` },
  { id: `t${index}`, role: "tool", text: "Read source", tool: { callId: `call${index}`, title: "Read source", status: "completed", detail: `Output for ${index}` } },
  { id: `t-second${index}`, role: "tool", text: "Read config", tool: { callId: `config${index}`, title: "Read config", status: "completed", detail: `Config for ${index}` } },
  { id: `a${index}`, role: "assistant", text: `Answer ${index}\n\n${"A measured paragraph with readable output. ".repeat(index % 5 + 1)}\n\n<details><summary>Inspect metadata</summary><p>Saved details ${index}</p></details>` },
]).flat();

function Fixture() {
  const [current, setCurrent] = useState(blocks);
  const [busy, setBusy] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(true);
  const [prependAnchor, setPrependAnchor] = useState<number>();
  const navigate = useRef<((id: string | null, query?: string) => boolean) | null>(null);
  const latest = useRef<(() => void) | null>(null);
  return <div className="flex h-full flex-col bg-background-base text-content">
    <div className="flex gap-4 p-3 font-sans">
      <span>2,000 turns</span>
      {[0, 1000, 1999].map((index) => <button key={index} onClick={() => navigate.current?.(`u${index}`)}>Jump {index}</button>)}
      <button onClick={() => latest.current?.()}>Latest</button>
      <button onClick={() => { setBusy(true); setCurrent((before) => before.map((block, index) =>
        index === before.length - 1 ? { ...block, text: `${block.text}\n\nNew live output.`, streaming: true } : block)); }}>Append latest</button>
      <button onClick={() => { setBusy(false); setCurrent((before) => before.map((block) => block.streaming ? { ...block, streaming: false } : block)); }}>Finish</button>
      {prependAnchor != null ? <output data-prepend-anchor>{prependAnchor}</output> : null}
    </div>
    <div className="min-h-0 flex-1"><AgentTranscript blocks={current} busy={busy} initialTurns={2000}
      hasEarlier={hasEarlier} onLoadEarlier={async (beforePrepend) => {
        setPrependAnchor(document.querySelector('[data-transcript-turn="u0"]')?.getBoundingClientRect().top);
        beforePrepend();
        setCurrent((before) => [
          ...Array.from({ length: 20 }, (_, index): Block[] => [
            { id: `old-u${index}`, role: "user", text: `Older question ${index}` },
            { id: `old-a${index}`, role: "assistant", text: `Older answer ${index}` },
          ]).flat(), ...before,
        ]);
        setHasEarlier(false);
      }} onNavigateReady={(callback) => { navigate.current = callback; }}
      onJumpToBottomReady={(callback) => { latest.current = callback; }} /></div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
