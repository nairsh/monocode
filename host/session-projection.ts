import type { Block } from "../src/features/sessions/model/session";

const DETAIL_BYTES = 64 * 1024;

/** Only finished, informational output is projected. Decisions and live output
 * retain their complete contract. Full output remains available by revision. */
export function projectHostBlock(block: Block, revision: number): Block {
  if (block.role !== "tool" || block.streaming || block.approval || block.agentRun ||
    !block.tool || !["completed", "complete", "success", "error", "failed"].includes(block.tool.status ?? "")) return block;
  const bytes = Buffer.byteLength(JSON.stringify(block));
  if (bytes <= DETAIL_BYTES) return block;
  return {
    ...block,
    text: block.text.slice(0, 2048),
    tool: { ...block.tool, detail: block.tool.detail?.slice(0, 2048),
      preview: block.tool.preview ? { ...block.tool.preview, lines: block.tool.preview.lines?.slice(0, 12).map((line) => ({ ...line, text: line.text.slice(0, 256) })), output: block.tool.preview.output?.slice(0, 2048) } : undefined },
    remoteDetail: { revision, bytes },
  };
}
