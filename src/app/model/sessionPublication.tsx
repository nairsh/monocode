import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import type { Session } from "../../features/sessions/model/session";

/** Detail subscribers follow one session; shell state publishes structural changes. */
export class SessionPublication {
  private sessions = new Map<string, Session>();
  private listeners = new Map<string, Set<() => void>>();
  private all = new Set<() => void>();

  constructor(sessions: Session[]) { this.replace(sessions); }
  get(id: string) { return this.sessions.get(id); }
  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
  subscribeAll = (listener: () => void) => {
    this.all.add(listener);
    return () => { this.all.delete(listener); };
  };
  replace(sessions: Session[]) {
    const next = new Map(sessions.map((session) => [session.id, session]));
    const changed = new Set([...this.sessions.keys(), ...next.keys()]);
    for (const id of changed) if (this.sessions.get(id) === next.get(id)) changed.delete(id);
    this.sessions = next;
    for (const id of changed) for (const listener of this.listeners.get(id) ?? []) listener();
    if (changed.size) for (const listener of this.all) listener();
  }
}

export const SessionDetailContext = createContext<SessionPublication | null>(null);

export function useSessionPublication(initial: () => Session[]) {
  const [sessions, setShell] = useState(initial);
  const sessionsRef = useRef(sessions);
  const shellRef = useRef(sessions);
  const [sessionPublication] = useState(() => new SessionPublication(sessions));
  const publishDetails = useCallback((next: Session[]) => {
    sessionsRef.current = next;
    sessionPublication.replace(next);
  }, [sessionPublication]);
  const setSessions = useCallback((action: SetStateAction<Session[]>) => {
    const next = typeof action === "function" ? action(sessionsRef.current) : action;
    // Direct array updates often carry unchanged objects from the shell. Keep
    // their newer detail instead of rolling back an unrelated streamed tail.
    const shellById = new Map(shellRef.current.map((session) => [session.id, session]));
    const currentById = new Map(sessionsRef.current.map((session) => [session.id, session]));
    const published = next.map((session) => {
      const shell = shellById.get(session.id);
      const current = currentById.get(session.id);
      return shell && current && session.blocks === shell.blocks && current.blocks !== shell.blocks
        ? { ...session, blocks: current.blocks } : session;
    });
    shellRef.current = published;
    publishDetails(published);
    setShell(published);
  }, [publishDetails]);
  return { sessions, sessionsRef, sessionPublication, setSessions, publishDetails };
}

export function useSessionDetail(fallback: Session | undefined, visible: boolean) {
  const store = useContext(SessionDetailContext);
  const id = fallback?.id;
  const subscribe = useCallback((listener: () => void) =>
    store && id && visible ? store.subscribe(id, listener) : () => {},
  [store, id, visible]);
  const snapshot = useCallback(() =>
    visible && id ? store?.get(id) ?? fallback : fallback,
  [store, id, visible, fallback]);
  return useSyncExternalStore(subscribe, snapshot, () => fallback);
}

/** Only an immutable text edit to an existing live tail can bypass the shell. */
export function onlyLiveTextChanged(before: Session, next: Session): boolean {
  if (!before.busy || !next.busy || before.blocks.length !== next.blocks.length) return false;
  if (Object.keys(next).some((key) => key !== "blocks" &&
    !Object.is(next[key as keyof Session], before[key as keyof Session]))) return false;
  if (Object.keys(before).some((key) => !(key in next))) return false;
  const tail = next.blocks[next.blocks.length - 1];
  const oldTail = before.blocks[before.blocks.length - 1];
  if (!tail || !oldTail || !["assistant", "reasoning"].includes(tail.role) ||
    tail.id !== oldTail.id || tail.role !== oldTail.role) return false;
  if (Object.keys(tail).some((key) => key !== "text" &&
    !Object.is(tail[key as keyof typeof tail], oldTail[key as keyof typeof oldTail]))) return false;
  if (Object.keys(oldTail).some((key) => !(key in tail))) return false;
  return next.blocks.every((block, index) => index === next.blocks.length - 1 || block === before.blocks[index]);
}
