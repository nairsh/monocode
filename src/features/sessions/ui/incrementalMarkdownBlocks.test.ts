import { expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMarkdownIntoBlocks } from "streamdown";
import { createIncrementalMarkdownBlocks } from "./incrementalMarkdownBlocks";

it("matches full block parsing across streaming boundaries, edits and document-wide syntax", () => {
  const incremental = createIncrementalMarkdownBlocks();
  for (const source of [
    "Intro\n\n```ts\nconst x = 1;\n```\n\nMore **text**\n\n- one\n- two",
    "~~~python\nprint('🦊')\n~~~\n\nparagraph",
    "[link][id]\n\n```js\ncode\n```\n\n[id]: /target",
    "footnote[^a]\n\n```js\ncode\n```\n\n[^a]: note",
    "> quoted\n> ```js\n> const value=1;\n> ```\n\nnext",
    "<div>\n\n```html\ntext\n```\n\n</div>",
    "$$x\n\n```js\ncode\n```\n\n+y$$", "\uFEFFtext", "code\r\nnext",
    "```ts\ncode\n```  \n\nafter", "```\ncode\n```\n", "```\ncode\n```\n\n",
    "- nested\n\n  ```js\n  code\n  ```\n\n  next", "    ```js\n    indented\n    ```\n\nnext",
    "```js\ncode\n```\n\nnew footnote[^later]", "```js\ncode\n```\n\n[id]: target",
  ]) {
    for (let length = 1; length <= source.length; length++)
      expect(incremental(source.slice(0, length))).toEqual(parseMarkdownIntoBlocks(source.slice(0, length)));
    expect(incremental(source.slice(0, 5))).toEqual(parseMarkdownIntoBlocks(source.slice(0, 5)));
    expect(incremental(source.replace("code", "edited"))).toEqual(parseMarkdownIntoBlocks(source.replace("code", "edited")));
  }
});

it("parses only a growing suffix after a completed fence", () => {
  const parse = vi.fn(parseMarkdownIntoBlocks);
  const incremental = createIncrementalMarkdownBlocks(parse);
  const prefix = `\`\`\`ts\n${"const value = 1;\n".repeat(200)}\`\`\`\n\n`;
  incremental(prefix + "x");
  parse.mockClear();
  for (let length = 1; length <= 30; length++) incremental(prefix + "x".repeat(length));
  const parsedCharacters = parse.mock.calls.reduce((sum, [source]) => sum + source.length, 0);
  expect(parsedCharacters).toBe(465);
  const full = vi.fn(parseMarkdownIntoBlocks);
  for (let length = 1; length <= 30; length++) full(prefix + "x".repeat(length));
  if (process.env.MONOCODE_PERF_OUTPUT_DIR) {
    mkdirSync(process.env.MONOCODE_PERF_OUTPUT_DIR, { recursive: true });
    writeFileSync(join(process.env.MONOCODE_PERF_OUTPUT_DIR, "perf-markdown-blocks.json"), JSON.stringify({
      updates: 30, completedLines: 200, parsedCharacters,
      fullParserCharacters: full.mock.calls.reduce((sum, [source]) => sum + source.length, 0),
    }));
  }
});
