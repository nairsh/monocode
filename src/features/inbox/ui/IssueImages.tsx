import { useEffect, useRef, useState } from "react";
import {
  attachmentsFromFiles,
  filesFromClipboard,
  pickAttachments,
  revokeAttachment,
} from "../../sessions/model/attachments";
import { nativeClipboardAttachments } from "../../../platform/tauri/clipboard";
import { useFileDrop } from "../../sessions/hooks/useFileDrop";
import { AttachmentChip } from "../../sessions/ui/AttachmentChip";
import type { Attachment } from "../../sessions/model/session";
import { ImagePlus, LoaderCircle } from "../../../shared/ui/icons";
import {
  loadIssueImages,
  saveIssueImages,
  type IssueImage,
} from "../model/localIssueImages";

const NO_IMAGES: IssueImage[] = [];

export function IssueImages({
  images = NO_IMAGES,
  onChange,
  onError,
  disabled = false,
  onBusy,
}: {
  images?: IssueImage[];
  onChange: (images: IssueImage[]) => void;
  onError: (reason: unknown) => void;
  disabled?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [previews, setPreviews] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const handlers = useRef({ images, onChange, onError, onBusy });
  handlers.current = { images, onChange, onError, onBusy };
  useEffect(() => {
    let alive = true;
    void loadIssueImages(images).then(
      (files) => {
        if (alive) setPreviews(files);
      },
      (reason) => {
        if (alive) handlers.current.onError(reason);
      },
    );
    return () => {
      alive = false;
    };
  }, [images]);
  const read = (reader: () => Promise<Attachment[]>) => {
    if (flight.current || disabled) return;
    flight.current = true;
    setBusy(true);
    handlers.current.onBusy?.(true);
    void (async () => {
      const files = await reader();
      try {
        if (!files.length) return;
        if (handlers.current.images.length + files.length > 20)
          throw new Error("An issue can contain up to 20 images.");
        const saved = await saveIssueImages(files);
        handlers.current.onChange([...handlers.current.images, ...saved]);
      } finally {
        files.forEach(revokeAttachment);
      }
    })()
      .catch((reason) => handlers.current.onError(reason))
      .finally(() => {
        flight.current = false;
        setBusy(false);
        handlers.current.onBusy?.(false);
      });
  };
  const dropState = useRef({ attachmentsSupported: true, remote: false });
  const dragging = useFileDrop({
    anchor,
    enabled: !disabled,
    state: dropState,
    read,
    onError,
  });
  useEffect(() => {
    const root = anchor.current?.closest("[data-session-drop]");
    const paste = (event: Event) => {
      const clipboard = (event as ClipboardEvent).clipboardData;
      const files = filesFromClipboard(clipboard);
      const text = clipboard?.getData("text/plain") ?? "";
      if (!files.length && text) return;
      event.preventDefault();
      read(
        files.length
          ? () => attachmentsFromFiles(files)
          : async () => (await nativeClipboardAttachments("")).files,
      );
    };
    root?.addEventListener("paste", paste);
    return () => root?.removeEventListener("paste", paste);
  }, [disabled]);
  return (
    <div
      ref={anchor}
      className={`it-images ${dragging ? "it-images-dragging" : ""}`}
    >
      {previews.map((file) => (
        <AttachmentChip
          key={file.id}
          attachment={file}
          large
          onRemove={
            disabled
              ? undefined
              : () => onChange(images.filter((image) => image.id !== file.id))
          }
        />
      ))}
      <button
        type="button"
        className="it-chip"
        disabled={busy || disabled}
        onClick={() => read(pickAttachments)}
      >
        {busy ? (
          <LoaderCircle className="it-icon animate-spin" />
        ) : (
          <ImagePlus className="it-icon" />
        )}
        {busy ? "Saving images…" : "Attach images"}
      </button>
    </div>
  );
}
