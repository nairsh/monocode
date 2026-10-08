// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSession, type Session } from "../../features/sessions/model/session";
import { applyHarnessEvents } from "../../integrations/harness/core/apply";
import { SessionDetailContext, onlyLiveTextChanged, useSessionDetail, useSessionPublication } from "./sessionPublication";

it("publishes live detail without shell/hidden commits and rebases subsequent mutations", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seed: Session[] = Array.from({ length: 6 }, (_, index) => ({
    ...newSession("codex", "/tmp/perf"), id: String(index), busy: true,
    blocks: [{ id: `u${index}`, role: "user", text: "Question" },
      { id: `a${index}`, role: "assistant", text: "Answer", streaming: true }],
  }));
  let publication!: ReturnType<typeof useSessionPublication>;
  let shellCommits = 0;
  let hiddenCommits = 0;
  const Detail = ({ session, visible }: { session: Session; visible: boolean }) => {
    if (!visible) hiddenCommits++;
    const detail = useSessionDetail(session, visible)!;
    return createElement("div", { "data-session": detail.id }, detail.blocks[1]?.text);
  };
  const Shell = () => {
    publication = useSessionPublication(() => seed);
    shellCommits++;
    return createElement(SessionDetailContext.Provider, { value: publication.sessionPublication },
      publication.sessions.map((session, index) => createElement(Detail, {
        key: session.id, session, visible: index === 0,
      })),
    );
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(Shell)));
    for (let tick = 0; tick < 30; tick++) {
      act(() => {
        const before = publication.sessionsRef.current;
        const next = before.map((session) => applyHarnessEvents(session, [{ type: "message.delta", text: "x" }]));
        expect(next.every((session, index) => onlyLiveTextChanged(before[index], session))).toBe(true);
        publication.publishDetails(next);
      });
    }
    expect(shellCommits).toBe(1);
    expect(hiddenCommits).toBe(5);
    if (process.env.MONOCODE_PERF_OUTPUT_DIR) {
      mkdirSync(process.env.MONOCODE_PERF_OUTPUT_DIR, { recursive: true });
      writeFileSync(join(process.env.MONOCODE_PERF_OUTPUT_DIR, "perf-shell-publication.json"), JSON.stringify({
        sessions: 6, replayBatches: 30, shellCommitsDuringTextReplay: shellCommits - 1,
        hiddenCommitsDuringTextReplay: hiddenCommits - 5,
        scope: "Production publication hook with a surrogate shell; actual SessionPane and Mono panel consumers have separate integration tests",
      }));
    }
    expect(host.querySelector('[data-session="0"]')?.textContent).toBe(`Answer${"x".repeat(30)}`);
    // Unrelated direct updates based on shell rows must preserve newer text.
    act(() => publication.setSessions(publication.sessions.map((session) => ({ ...session, title: "renamed" }))));
    expect(publication.sessionsRef.current[0].blocks[1].text).toBe(`Answer${"x".repeat(30)}`);
    act(() => publication.setSessions((current) => current.map((session) => ({ ...session, busy: false }))));
    expect(publication.sessionsRef.current.every((session) => !session.busy)).toBe(true);
    // An explicit historical edit/rewind is authoritative, never merged away.
    act(() => publication.setSessions(publication.sessions.map((session) => ({ ...session, blocks: session.blocks.slice(0, 1) }))));
    expect(publication.sessionsRef.current[0].blocks).toHaveLength(1);
  } finally {
    act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();
  }
});

it("requires shell publication for structural, approval and lifecycle changes", () => {
  const session: Session = { ...newSession("codex", "/tmp/perf"), busy: true,
    blocks: [{ id: "a", role: "assistant", text: "answer", streaming: true }] };
  for (const next of [
    { ...session, busy: false },
    { ...session, title: "new title" },
    { ...session, pendingQuestion: { requestId: 1, questions: [] } },
    { ...session, blocks: [...session.blocks, { id: "approval", role: "approval" as const, text: "", approval: { requestId: 1 } }] },
    { ...session, blocks: [{ ...session.blocks[0], streaming: false }] },
  ]) expect(onlyLiveTextChanged(session, next)).toBe(false);
});
