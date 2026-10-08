import { useEffect, useRef, useState } from "react";
import {
  attachmentsFromFiles,
  filesFromClipboard,
  MAX_ATTACHMENTS,
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

/** Loads preview attachments for saved issue images, reporting failures once per load. */
export function useIssueImages(
  images: IssueImage[] | undefined,
  onError: (reason: unknown) => void,
) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    let alive = true;
    void loadIssueImages(images).then(
      (loaded) => {
        if (alive) setFiles(loaded);
      },
      (reason) => {
        if (alive) report.current(reason);
      },
    );
    return () => {
      alive = false;
    };
  }, [images]);
  return files;
}

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
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const handlers = useRef({ images, onChange, onError, onBusy });
  handlers.current = { images, onChange, onError, onBusy };
  const previews = useIssueImages(images, (reason) =>
    handlers.current.onError(reason),
  );
  const read = (reader: () => Promise<Attachment[]>) => {
    if (flight.current || disabled) return;
    flight.current = true;
    setBusy(true);
    handlers.current.onBusy?.(true);
    void (async () => {
      const files = await reader();
      try {
        if (!files.length) return;
        if (handlers.current.images.length + files.length > MAX_ATTACHMENTS)
          throw new Error(
            `An issue can contain up to ${MAX_ATTACHMENTS} images.`,
          );
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
