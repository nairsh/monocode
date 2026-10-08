import { invoke } from "@tauri-apps/api/core";
import {
  MAX_ATTACHMENTS,
  MAX_EMBED_BYTES,
} from "../../sessions/model/attachments";
import type { Attachment } from "../../sessions/model/session";

export type IssueImage = Pick<Attachment, "id" | "name" | "mimeType" | "size">;

export function issueProofPaths(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/!\[[^\]]*\]\(<?(\/[^\n)]+?)>?\)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

function openImages(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("monocode.localIssueImages.v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("images", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Local image storage is unavailable."));
    request.onblocked = () =>
      reject(
        new Error(
          "Close other MonoCode windows and try saving the images again.",
        ),
      );
  });
}

/** Copy image bytes locally; original files and temporary clipboard paths may disappear. */
export async function saveIssueImages(
  files: Attachment[],
): Promise<IssueImage[]> {
  if (!files.length) return [];
  if (files.length > MAX_ATTACHMENTS)
    throw new Error(`An issue can contain up to ${MAX_ATTACHMENTS} images.`);
  const images = await Promise.all(
    files.map(async (file) => {
      if (file.kind !== "image" || file.size > MAX_EMBED_BYTES)
        throw new Error("Attach images up to 20 MB each.");
      const data =
        file.data ??
        (file.path
          ? await invoke<string>("read_file_base64", { path: file.path })
          : undefined);
      if (!data)
        throw new Error(`Could not read ${file.name}. Attach the image again.`);
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        kind: "image" as const,
        data,
      };
    }),
  );
  const db = await openImages();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("images", "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("The images could not be saved."));
    for (const image of images) transaction.objectStore("images").put(image);
  }).finally(() => db.close());
  return images.map(({ id, name, mimeType, size }) => ({
    id,
    name,
    mimeType,
    size,
  }));
}

export async function loadIssueImages(
  images: readonly IssueImage[] = [],
): Promise<Attachment[]> {
  if (!images.length) return [];
  const db = await openImages();
  try {
    return await Promise.all(
      images.map(
        (image) =>
          new Promise<Attachment>((resolve, reject) => {
            const request = db
              .transaction("images", "readonly")
              .objectStore("images")
              .get(image.id);
            request.onsuccess = () =>
              request.result?.data
                ? resolve(request.result)
                : reject(
                    new Error(
                      `The saved image ${image.name} is missing. Attach it again before starting this issue.`,
                    ),
                  );
            request.onerror = () =>
              reject(
                request.error ?? new Error("The image could not be loaded."),
              );
          }),
      ),
    );
  } finally {
    db.close();
  }
}
