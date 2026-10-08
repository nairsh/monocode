import { useEffect, useRef, useState, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
  type Editor,
  type NodeViewProps,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import { GlassBackdrop } from "../../../app/shell/GlassBackdrop";
import { MarkdownImage } from "../../sessions/ui/AgentMarkdown";
import { MarkdownSourceEditor } from "../../sessions/ui/MarkdownSourceEditor";
import {
  Bold,
  CheckList,
  Code,
  Heading1,
  Heading2,
  Italic,
  Link,
  ListBullet,
  ListNumber,
  Quote,
  Strikethrough,
} from "../../../shared/ui/icons";

// Shows the resolved file while the document keeps the note's relative path.
const NoteImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(({ node }: NodeViewProps) => (
      <NodeViewWrapper>
        <MarkdownImage src={node.attrs.src} alt={node.attrs.alt ?? ""} />
      </NodeViewWrapper>
    ));
  },
}).configure({ allowBase64: true });

type Tool = {
  label: string;
  icon: typeof Bold;
  active: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
};

const chain = (editor: Editor) => editor.chain().focus();
const TOOLS: Tool[][] = [
  [
    { label: "Heading 1", icon: Heading1, active: (e) => e.isActive("heading", { level: 1 }), run: (e) => chain(e).toggleHeading({ level: 1 }).run() },
    { label: "Heading 2", icon: Heading2, active: (e) => e.isActive("heading", { level: 2 }), run: (e) => chain(e).toggleHeading({ level: 2 }).run() },
  ],
  [
    { label: "Bold", icon: Bold, active: (e) => e.isActive("bold"), run: (e) => chain(e).toggleBold().run() },
    { label: "Italic", icon: Italic, active: (e) => e.isActive("italic"), run: (e) => chain(e).toggleItalic().run() },
    { label: "Strikethrough", icon: Strikethrough, active: (e) => e.isActive("strike"), run: (e) => chain(e).toggleStrike().run() },
    { label: "Code", icon: Code, active: (e) => e.isActive("code"), run: (e) => chain(e).toggleCode().run() },
  ],
  [
    { label: "Bulleted list", icon: ListBullet, active: (e) => e.isActive("bulletList"), run: (e) => chain(e).toggleBulletList().run() },
    { label: "Numbered list", icon: ListNumber, active: (e) => e.isActive("orderedList"), run: (e) => chain(e).toggleOrderedList().run() },
    { label: "To-do list", icon: CheckList, active: (e) => e.isActive("taskList"), run: (e) => chain(e).toggleTaskList().run() },
    { label: "Quote", icon: Quote, active: (e) => e.isActive("blockquote"), run: (e) => chain(e).toggleBlockquote().run() },
  ],
];
const TOOL_BUTTON =
  "grid size-7 place-items-center rounded-lg text-content/70 hover:bg-content/6 hover:text-content aria-pressed:bg-content/10 aria-pressed:text-content";

function SelectionToolbar({ editor }: { editor: Editor }) {
  const [link, setLink] = useState<string | null>(null);
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      tools: TOOLS.map((group) => group.map((tool) => tool.active(editor))),
      link: editor.isActive("link"),
    }),
  });
  const applyLink = (href: string) => {
    const range = chain(editor).extendMarkRange("link");
    if (href.trim()) range.setLink({ href: href.trim() }).run();
    else range.unsetLink().run();
    setLink(null);
  };
  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8, onHide: () => setLink(null) }}
      className="isolate rounded-xl border border-content/10 shadow-xl"
    >
      <GlassBackdrop />
      <div
        role="toolbar"
        aria-label="Format text"
        className="relative z-[1] flex items-center gap-0.5 p-1 font-sans"
        onMouseDown={(event) => {
          // Keep the editor's selection while a button is pressed.
          if (!(event.target as HTMLElement).closest("input"))
            event.preventDefault();
        }}
      >
        {link !== null ? (
          <input
            autoFocus
            aria-label="Link URL"
            placeholder="Paste a link…"
            value={link}
            className="h-7 w-56 rounded-lg bg-transparent px-2 text-[13px] text-content outline-none placeholder:text-content/40"
            onChange={(event) => setLink(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                applyLink(link);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setLink(null);
                editor.commands.focus();
              }
            }}
          />
        ) : (
          <>
            {TOOLS.map((group, g) => (
              <div key={g} className="flex items-center gap-0.5">
                {g ? <span className="mx-0.5 h-4 w-px bg-content/10" /> : null}
                {group.map((tool, t) => (
                  <button
                    key={tool.label}
                    type="button"
                    title={tool.label}
                    aria-label={tool.label}
                    aria-pressed={active.tools[g][t]}
                    className={TOOL_BUTTON}
                    onClick={() => tool.run(editor)}
                  >
                    <tool.icon className="size-4" />
                  </button>
                ))}
              </div>
            ))}
            <span className="mx-0.5 h-4 w-px bg-content/10" />
            <button
              type="button"
              title="Link"
              aria-label="Link"
              aria-pressed={active.link}
              className={TOOL_BUTTON}
              onClick={() => setLink(editor.getAttributes("link").href ?? "")}
            >
              <Link className="size-4" />
            </button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

// Raw HTML and footnotes don't survive the rich editor's Markdown round trip.
const SOURCE_ONLY = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>|<!--|^ {0,3}\[\^[^\]]+\]:/im;

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Return true when the paste was handled. */
  onPaste: (event: ClipboardEvent) => boolean;
  editorRef: RefObject<Editor | null>;
};

/** Rich-text note body, stored as Markdown. */
export function NoteMarkdownEditor(props: Props) {
  // Chosen once per note so typing never swaps editors mid-edit.
  const [sourceOnly] = useState(() => SOURCE_ONLY.test(props.value));
  return sourceOnly ? (
    <div aria-label="Note body">
      <MarkdownSourceEditor
        label="Note text"
        value={props.value}
        onChange={props.onChange}
        lineNumbers={false}
        className="min-h-[448px]"
      />
    </div>
  ) : (
    <RichNoteEditor {...props} />
  );
}

function RichNoteEditor({
  value,
  onChange,
  onPaste,
  editorRef,
}: Props) {
  // Only real edits emit, so opening a note never rewrites its Markdown.
  const emitted = useRef(value);
  const handlers = useRef({ onChange, onPaste });
  handlers.current = { onChange, onPaste };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Markdown has no underline syntax.
        underline: false,
        link: { openOnClick: false },
      }),
      Markdown,
      NoteImage,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
      Placeholder.configure({ placeholder: "Write a note…" }),
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: { class: "note-editor", "aria-label": "Note text" },
      handlePaste: (_view, event) => handlers.current.onPaste(event),
      handleClick: (_view, _pos, event) => {
        const href = (event.target as HTMLElement).closest("a")?.href;
        if (!href || !(event.metaKey || event.ctrlKey)) return false;
        void openUrl(href).catch(() => undefined);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      emitted.current = editor.getMarkdown();
      handlers.current.onChange(emitted.current);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);

  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    // An outside refresh is not something ⌘Z should undo.
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(value, { contentType: "markdown", emitUpdate: false })
      .run();
  }, [editor, value]);

  return (
    <div aria-label="Note body">
      <EditorContent editor={editor} />
      <SelectionToolbar editor={editor} />
    </div>
  );
}
