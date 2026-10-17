/** Confirmed launches only; the sidebar does not infer provenance from folders. */
export type SessionOrigin = { monoId: string; name: string };
const KEY = "monocode.sessionOrigins.v1";
const CHANGED = "monocode:session-origins-changed";
let raw: string | null | undefined;
let cached: Record<string, SessionOrigin> = {};
function origins() {
  try {
    const next = localStorage.getItem(KEY);
    if (next !== raw) {
      raw = next;
      const parsed = JSON.parse(next ?? "{}");
      cached =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
    }
  } catch {
    cached = {};
  }
  return cached;
}
export function sessionOrigin(id: string): SessionOrigin | undefined {
  const value = origins()[id];
  return value &&
    typeof value.name === "string" &&
    typeof value.monoId === "string"
    ? value
    : undefined;
}
export function recordSessionOrigin(id: string, origin: SessionOrigin) {
  if (sessionOrigin(id)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...origins(), [id]: origin }));
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* Provenance must never turn an accepted launch into a failure. */
  }
}
export function subscribeSessionOrigins(listener: () => void) {
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", listener);
  };
}
