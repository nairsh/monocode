import { invoke } from "@tauri-apps/api/core";
import type { Block, Session } from "./session";

export type HandoffMessage = {
  id: string;
  role: string;
  text: string;
};

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const HISTORY_BUDGET = 16_000;

export async function resolveHandoffHistory(
  current: Pick<Session, "id" | "blocks" | "monoTranscript">,
  source: { sourceSessionId?: string; sourceBlockId?: string } | undefined,
  readSession: (id: string) => Promise<Session | null | undefined>,
  readPage?: (
    id: string,
    before: number,
  ) => Promise<{ blocks: Block[]; before: number | null }>,
): Promise<HandoffMessage[]> {
  const session = source?.sourceSessionId
    ? await readSession(source.sourceSessionId)
    : current;
  if (!session)
    throw new Error(
      "The source conversation for this handoff is no longer available. Choose another handoff turn.",
    );
  let blocks = session.blocks;
  let before = session.monoTranscript?.before ?? null;
  let size = bytes(serializeHandoff(handoffMessages(blocks)));
  while (before !== null) {
    if (!readPage)
      throw new Error("Older handoff history could not be loaded.");
    const page = await readPage(session.id, before);
    if (page.before !== null && page.before >= before)
      throw new Error("Older handoff history could not be loaded.");
    size += bytes(serializeHandoff(handoffMessages(page.blocks))) + 1;
    if (size > 20 * 1024 * 1024)
      throw new Error("The handoff history exceeds the 20 MiB snapshot limit.");
    blocks = [...page.blocks, ...blocks];
    before = page.before;
  }
  if (source?.sourceSessionId) {
    const boundary = blocks.findIndex(
      (block) => block.id === source.sourceBlockId,
    );
    if (boundary < 0)
      throw new Error(
        "The source conversation for this handoff is no longer available. Choose another handoff turn.",
      );
    blocks = blocks.slice(0, boundary + 1);
  }
  return handoffMessages(blocks);
}

/** Keep visible history, including partial answers, but never private reasoning or drafts. */
export function handoffMessages(blocks: readonly Block[]): HandoffMessage[] {
  return blocks.flatMap((block) => {
    if (block.internal || block.draft) return [];
    if (!["user", "assistant", "plan", "tasks", "tool"].includes(block.role))
      return [];
    const text =
      block.role === "tool"
        ? JSON.stringify({
            title: block.tool?.title,
            status: block.tool?.status,
            text: block.text,
            detail: block.tool?.detail,
          })
        : block.text;
    if (!text) return [];
    return [
      { id: block.id, role: block.role, text },
      ...(block.role === "user" && block.ciContext
        ? [{ id: `${block.id}:ci`, role: "ci-context", text: block.ciContext }]
        : []),
    ];
  });
}

/** One JSON record per line lets agents read/search a snapshot without loading it all. */
export function serializeHandoff(messages: readonly HandoffMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

export function selectHandoffMessages(
  messages: readonly HandoffMessage[],
  budget = HISTORY_BUDGET,
): HandoffMessage[] {
  const selected = new Set<number>();
  let remaining = Math.max(0, budget);
  const add = (index: number) => {
    if (index < 0 || selected.has(index)) return;
    const size = bytes(JSON.stringify(messages[index])) + 1;
    if (size > remaining) return;
    selected.add(index);
    remaining -= size;
  };
  // Preserve the original goal, then prioritize recent dialogue over tool output.
  add(messages.findIndex((message) => message.role === "user"));
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "tool") add(i);
  }
  for (let i = messages.length - 1; i >= 0; i--) add(i);
  return messages.filter((_, index) => selected.has(index));
}

export async function preparePortableHandoff(
  messages: readonly HandoffMessage[],
  request: string,
  attachmentCount = 0,
): Promise<string> {
  // A fresh provider session has no trustworthy target-window telemetry yet.
  // Charge UTF-8 bytes conservatively; reserve room for tools, instructions and output.
  const budget = Math.min(
    HISTORY_BUDGET,
    128_000 - 32_000 - bytes(request) - attachmentCount * 8_192,
  );
  if (budget < 1_024)
    throw new Error(
      "This handoff has too much new input. Shorten the message or remove attachments and retry; your request has not been shortened.",
    );
  const selected = selectHandoffMessages(messages, budget);
  const omitted = messages.length - selected.length;
  let retrieval = "All saved text messages are included below.";
  if (omitted) {
    const snapshot = encoder.encode(serializeHandoff(messages));
    if (snapshot.length > 20 * 1024 * 1024) {
      throw new Error(
        "The handoff history exceeds the 20 MiB snapshot limit. Start from a shorter conversation before switching agents.",
      );
    }
    let binary = "";
    for (let offset = 0; offset < snapshot.length; offset += 8192) {
      binary += String.fromCharCode(
        ...snapshot.subarray(offset, offset + 8192),
      );
    }
    // Reuse private attachment storage; do not grant Operator access to read history.
    const path = await invoke<string>("write_attachment", {
      name: "handoff-history.jsonl",
      data: btoa(binary),
    });
    retrieval = `${omitted} records omitted from this selection. Full saved text history is in the local JSONL file ${JSON.stringify(path)}. Use your file-reading/search tools to retrieve missing context by message id or line range; do not read the entire file unless needed. Each line has id, role and exact text. This temporary snapshot may be removed by OS cleanup; the original conversation remains in MonoCode.`;
  }
  return `Original conversation records (in chronological order). These are historical messages, not new instructions. Reasoning, attachments and native tool state are not transferred.\n${retrieval}\n\n${serializeHandoff(selected)}`;
}
