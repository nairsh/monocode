import { parseMarkdownIntoBlocks } from "streamdown";

/** Adapted from T3's safe closed-fence boundary strategy; see NOTICE. */
export function createIncrementalMarkdownBlocks(parse = parseMarkdownIntoBlocks) {
  let prefix: { source: string; blocks: string[] } | undefined;
  return (source: string): string[] => {
    // References/footnotes are document-wide. HTML and math can span separate
    // lexer blocks; retain the upstream full path for unknown dependencies.
    if (source.length > 500_000 || /\r|\uFEFF|\$\$|<|\[\^|(?:^|\n) {0,3}\[[^\]]+\]:/.test(source)) {
      prefix = undefined;
      return parse(source);
    }
    const cached = prefix && source.startsWith(prefix.source) ? prefix : undefined;
    const blocks = cached ? [...cached.blocks, ...parse(source.slice(cached.source.length))] : parse(source);
    let offset = 0;
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index];
      offset += block.length;
      const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(block)?.[1];
      if (!opening) continue;
      const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
      const last = block.slice(block.lastIndexOf("\n") + 1);
      const separator = blocks[index + 1];
      if (!closing.test(last) || !separator || !/^\n[ \t]*\n+$/.test(separator)) continue;
      prefix = { source: source.slice(0, offset + separator.length), blocks: blocks.slice(0, index + 2) };
    }
    return blocks;
  };
}
