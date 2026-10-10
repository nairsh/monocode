import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  handoffMessages,
  preparePortableHandoff,
  resolveHandoffHistory,
  selectHandoffMessages,
  serializeHandoff,
} from "./portableHandoff";
import { newSession, type Block } from "./session";
import { wrapHandoffPrompt } from "./handoff";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe("portable handoff", () => {
  it("loads older Mono pages without mutating the live window, including a boundary on an older page", async () => {
    const current = {
      ...newSession("codex", "/tmp"),
      blocks: [{ id: "recent", role: "assistant", text: "recent" }] as Block[],
      monoTranscript: { before: 10, firstBlockId: "recent" },
    };
    const page = vi.fn().mockResolvedValue({
      blocks: [
        { id: "original", role: "user", text: "keep this requirement" },
        { id: "boundary", role: "system", text: "turn ended" },
      ],
      before: null,
    });
    const read = vi.fn().mockResolvedValue(current);
    const all = await resolveHandoffHistory(current, undefined, read, page);
    expect(all.map((message) => message.id)).toEqual(["original", "recent"]);
    expect(read).not.toHaveBeenCalled();
    const selected = await resolveHandoffHistory(
      current,
      {
        sourceSessionId: current.id,
        sourceBlockId: "boundary",
      },
      read,
      page,
    );
    expect(selected.map((message) => message.id)).toEqual(["original"]);
    expect(current.blocks).toHaveLength(1);
    page.mockResolvedValue({ blocks: [], before: 10 });
    await expect(
      resolveHandoffHistory(current, undefined, read, page),
    ).rejects.toThrow("could not be loaded");
  });

  it("preserves exact original messages and interrupted answers, excluding reasoning, drafts and internal work", async () => {
    const blocks: Block[] = [
      {
        id: "u",
        role: "user",
        text: "Keep **all** requirements.\n# Goal\n你好 🌍",
      },
      {
        id: "a",
        role: "assistant",
        text: "Partial work\n  unfinished",
        streaming: true,
      },
      { id: "r", role: "reasoning", text: "private reasoning" },
      { id: "d", role: "user", text: "unsent", draft: true },
      { id: "i", role: "user", text: "internal", internal: true },
      { id: "p", role: "plan", text: "1. Keep the API" },
      {
        id: "t",
        role: "tool",
        text: "Tests failed",
        tool: {
          callId: "test-run",
          title: "Tests",
          status: "error",
          detail: "expected 2, received 1",
        },
      },
    ];
    const messages = handoffMessages(blocks);
    expect(messages.map((message) => message.id)).toEqual(["u", "a", "p", "t"]);
    expect(messages[0].text).toBe(blocks[0].text);
    const context = await preparePortableHandoff(messages, "Continue");
    const prompt = wrapHandoffPrompt(
      "old recap",
      "claude",
      "Continue",
      [],
      context,
    );
    expect(prompt).toContain(JSON.stringify(messages[0]));
    expect(prompt).toContain(JSON.stringify(messages[1]));
    expect(prompt).toContain("expected 2, received 1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("prioritizes the original request and recent dialogue, retaining chronological order and whole records", () => {
    const messages = [
      { id: "goal", role: "user", text: "original constraint" },
      { id: "old", role: "assistant", text: "o".repeat(200) },
      { id: "huge", role: "tool", text: "x".repeat(5000) },
      { id: "recent", role: "user", text: "recent request" },
      { id: "partial", role: "assistant", text: "partial response" },
    ];
    const selected = selectHandoffMessages(messages, 250);
    expect(selected.map((message) => message.id)).toEqual([
      "goal",
      "recent",
      "partial",
    ]);
    expect(
      new TextEncoder().encode(serializeHandoff(selected)).length,
    ).toBeLessThanOrEqual(250);
    expect(messages[2].text).toHaveLength(5000);
  });

  it("budgets encoded UTF-8 bytes and JSON escaping, not JavaScript string length", () => {
    const messages = [{ id: "u", role: "user", text: '😀\n"'.repeat(50) }];
    const exact =
      new TextEncoder().encode(serializeHandoff(messages)).length + 1;
    expect(selectHandoffMessages(messages, exact)).toEqual(messages);
    expect(selectHandoffMessages(messages, exact - 1)).toEqual([]);
  });

  it("makes omitted and oversized text retrievable without truncating the current request", async () => {
    vi.mocked(invoke).mockResolvedValue('/tmp/a path/"handoff".jsonl');
    const messages = [
      { id: "large", role: "user", text: "你好".repeat(10_000) },
      { id: "answer", role: "assistant", text: "partial answer" },
    ];
    const request = "New requirement\n".repeat(1000);
    const context = await preparePortableHandoff(messages, request);
    const args = vi.mocked(invoke).mock.calls[0][1] as { data: string };
    const restored = new TextDecoder().decode(
      Uint8Array.from(atob(args.data), (c) => c.charCodeAt(0)),
    );
    expect(restored).toBe(serializeHandoff(messages));
    expect(context).toContain(JSON.stringify('/tmp/a path/"handoff".jsonl'));
    expect(context).toContain("1 records omitted");
    expect(wrapHandoffPrompt("", "codex", request, [], context)).toContain(
      request.trim(),
    );
  });

  it("fails explicitly if retrieval cannot be prepared or input leaves too little room", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Disk full"));
    await expect(
      preparePortableHandoff(
        [{ id: "u", role: "user", text: "x".repeat(20_000) }],
        "continue",
      ),
    ).rejects.toThrow("Disk full");
    await expect(
      preparePortableHandoff([], "x".repeat(96_000)),
    ).rejects.toThrow("has not been shortened");
  });

  it("restores a source session only through the selected handoff turn", async () => {
    const source = {
      ...newSession("claude", "/tmp"),
      blocks: [
        { id: "u", role: "user", text: "original" },
        { id: "a", role: "assistant", text: "selected answer" },
        { id: "future", role: "user", text: "later private task" },
      ] as Block[],
    };
    const read = vi.fn().mockResolvedValue(source);
    const messages = await resolveHandoffHistory(
      { id: "target", blocks: [] },
      { sourceSessionId: source.id, sourceBlockId: "a" },
      read,
    );
    expect(messages.map((message) => message.id)).toEqual(["u", "a"]);
    await expect(
      resolveHandoffHistory(
        { id: "target", blocks: [] },
        { sourceSessionId: source.id, sourceBlockId: "deleted" },
        read,
      ),
    ).rejects.toThrow("no longer available");
  });
});
