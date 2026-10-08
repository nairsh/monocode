import {
  useMemo,
  useState,
  type ClipboardEventHandler,
  type RefObject,
} from "react";
import { parseMarkdownIntoBlocks } from "streamdown";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";
import { MarkdownSourceEditor } from "../../sessions/ui/MarkdownSourceEditor";

/** A single document: Markdown renders in place around the block being edited. */
export function NoteMarkdownEditor({
  value,
  cwd,
  onChange,
  onPaste,
  textareaRef,
  selectionRef,
}: {
  value: string;
  cwd?: string;
  onChange: (value: string) => void;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  selectionRef: RefObject<{ start: number; end: number } | null>;
}) {
  const [editing, setEditing] = useState<{ start: number; end: number } | null>(
    value.trim() ? null : { start: 0, end: value.length },
  );
  const blocks = useMemo(() => {
    // Reference links and footnotes resolve across the whole document.
    if (/^ {0,3}\[[^\]]+\]:/m.test(value))
      return [{ start: 0, end: value.length }];
    let cursor = 0;
    const result: { start: number; end: number }[] = [];
    for (const block of parseMarkdownIntoBlocks(value)) {
      const start = value.indexOf(block, cursor);
      if (start < 0) continue;
      const end = start + block.length;
      if (block.trim()) result.push({ start: cursor, end });
      else if (result.length) result[result.length - 1].end = end;
      cursor = end;
    }
    if (result.length) result[result.length - 1].end = value.length;
    return result.length ? result : [{ start: 0, end: value.length }];
  }, [value]);
  const rememberSelection = () => {
    const field = textareaRef.current;
    if (field && editing) {
      selectionRef.current = {
        start: editing.start + field.selectionStart,
        end: editing.start + field.selectionEnd,
      };
    }
  };
  const renderBlock = (block: { start: number; end: number }) => (
    <div
      key={block.start}
      tabIndex={0}
      role="group"
      aria-label="Edit note text"
      className="min-h-6 cursor-text rounded-md outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      onClick={(event) => {
        // Rendered links, images and Markdown controls keep their normal behavior.
        if ((event.target as HTMLElement).closest("a, button, img")) return;
        if (window.getSelection()?.isCollapsed === false) return;
        selectionRef.current = { start: block.start, end: block.start };
        setEditing(block);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectionRef.current = { start: block.start, end: block.start };
          setEditing(block);
        }
      }}
    >
      <AgentMarkdown
        text={value.slice(block.start, block.end)}
        cwd={cwd}
        hardBreaks
      />
    </div>
  );
  return (
    <div className="flex min-h-[448px] flex-col gap-3" aria-label="Note body">
      {editing ? (
        <>
          {editing.start > 0 ? (
            <AgentMarkdown
              text={value.slice(0, editing.start)}
              cwd={cwd}
              hardBreaks
            />
          ) : null}
          <div
            onSelect={rememberSelection}
            onKeyUp={rememberSelection}
            onClick={rememberSelection}
          >
            <MarkdownSourceEditor
              textareaRef={textareaRef}
              autoFocus
              label="Note text"
              value={value.slice(editing.start, editing.end)}
              lineNumbers={false}
              className="min-h-20"
              onPaste={(event) => {
                rememberSelection();
                onPaste(event);
              }}
              onBlur={() => {
                rememberSelection();
                setEditing(null);
              }}
              onChange={(next) => {
                const end = editing.start + next.length;
                setEditing({ start: editing.start, end });
                onChange(
                  value.slice(0, editing.start) +
                    next +
                    value.slice(editing.end),
                );
              }}
            />
          </div>
          {editing.end < value.length ? (
            <AgentMarkdown
              text={value.slice(editing.end)}
              cwd={cwd}
              hardBreaks
            />
          ) : null}
        </>
      ) : (
        <>
          {blocks.map(renderBlock)}
          <button
            type="button"
            aria-label="Continue writing note"
            className="min-h-12 cursor-text text-left text-[13px] text-content/35 outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            onClick={() => {
              const prefix = value && !value.endsWith("\n\n") ? "\n\n" : "";
              const start = value.length + prefix.length;
              onChange(value + prefix);
              selectionRef.current = { start, end: start };
              setEditing({ start, end: start });
            }}
          >
            {value.trim() ? "" : "Write a note…"}
          </button>
        </>
      )}
    </div>
  );
}
