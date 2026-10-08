// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Block } from "../model/session";
import { RemoteToolDetail, RemoteToolDetailContext } from "./RemoteToolDetail";
import { copyText } from "../../../platform/tauri/clipboard";
vi.mock("../../../platform/tauri/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

it("loads full output, reports retryable failures, copies exact text and discards stale revisions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let block: Block = { id: "tool", role: "tool", text: "short", remoteDetail: { revision: 1, bytes: 90000 } };
  const full: Block = { ...block, text: "🦊 complete full output", remoteDetail: undefined };
  const load = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(full);
  const render = () => root.render(createElement(RemoteToolDetailContext.Provider, { value: load },
    createElement(RemoteToolDetail, { block }, createElement("span", null, "Tool summary"))));
  try {
    act(render);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("temporary failure");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.textContent).toContain(full.text);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(copyText).toHaveBeenCalledWith(full.text);
    const projected = block;
    block = full;
    act(render);
    expect(host.querySelectorAll("pre")).toHaveLength(1);
    expect(host.querySelector("pre")?.textContent).toBe(full.text);
    block = projected;
    block = { ...block, remoteDetail: { revision: 2, bytes: 90001 } };
    act(render);
    expect(host.textContent).not.toContain(full.text);
    expect(host.textContent).toContain("Load full output");
    let resolve!: (value: Block) => void;
    load.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    block = { ...block, remoteDetail: { revision: 3, bytes: 90002 } };
    act(render);
    await act(async () => resolve(full));
    expect(host.textContent).not.toContain(full.text);
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
