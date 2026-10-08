// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MonoActivityPanel } from "./MonoActivityPanel";
import { SessionDetailContext, SessionPublication } from "../../../app/model/sessionPublication";
import { newSession, type Session } from "../../sessions/model/session";
vi.mock("../../sessions/ui/AgentTranscript", () => ({
  MonoActivityTrail: ({ blocks }: { blocks: { text: string }[] }) => createElement("div", null, blocks.map((block) => block.text).join(" ")),
}));
it("keeps selected Mono activity current without root text publication", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const session: Session = { ...newSession("codex", "/tmp"), id: "mono", busy: true, blocks: [
    { id: "user", role: "user", text: "prompt" }, { id: "reasoning", role: "reasoning", text: "before" },
  ] };
  const store = new SessionPublication([session]);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(SessionDetailContext.Provider, { value: store }, createElement(MonoActivityPanel, {
      agent: { name: "Mono", mascot: "cat", color: "#abc" }, blocks: session.blocks, live: true,
      session, selection: { sessionId: "mono", turnId: "user", blocks: session.blocks }, onClose: () => {},
    }))));
    act(() => store.replace([{ ...session, blocks: [session.blocks[0], { ...session.blocks[1], text: "latest reasoning" }] }]));
    expect(host.textContent).toContain("latest reasoning");
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
