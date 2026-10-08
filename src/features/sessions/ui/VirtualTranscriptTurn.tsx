import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { flushSync } from "react-dom";

const TurnState = createContext<Map<string, unknown> | null>(null);
const adjustedViewports = new WeakSet<HTMLElement>();

export function consumeVirtualAnchorAdjustment(root: HTMLElement): boolean {
  const adjusted = adjustedViewports.has(root);
  adjustedViewports.delete(root);
  return adjusted;
}

export function preserveTranscriptAnchor(root: HTMLElement, update: () => void, target?: Element | null) {
  const rect = root.getBoundingClientRect();
  // Anchor real content, not an estimated placeholder partly covering the
  // viewport: that placeholder's own height can shrink before the next row.
  const anchor = target ?? [...root.querySelectorAll('[data-transcript-turn]:not([data-turn-placeholder])')]
    .find((node) => {
      const turn = node.getBoundingClientRect();
      return turn.bottom > rect.top && turn.top < rect.bottom;
    });
  const before = anchor?.getBoundingClientRect().top;
  flushSync(update);
  if (anchor?.isConnected && before != null) {
    const shift = anchor.getBoundingClientRect().top - before;
    root.scrollTop += shift;
    // The turn ResizeObserver still records the new heights, but must not
    // compensate this same measured change a second time.
    if (shift) adjustedViewports.add(root);
  }
}
const viewports = new WeakMap<HTMLElement, {
  observer: IntersectionObserver;
  callbacks: Map<Element, (entry: IntersectionObserverEntry) => void>;
  latest: Map<Element, IntersectionObserverEntry>;
  dispose: () => void;
}>();

function observeViewport(root: HTMLElement, node: Element, callback: (entry: IntersectionObserverEntry) => void) {
  let viewport = viewports.get(root);
  if (!viewport) {
    const callbacks = new Map<Element, (entry: IntersectionObserverEntry) => void>();
    const latest = new Map<Element, IntersectionObserverEntry>();
    const observer = new IntersectionObserver((entries) => {
      preserveTranscriptAnchor(root, () => {
        for (const entry of entries) {
          latest.set(entry.target, entry);
          callbacks.get(entry.target)?.(entry);
        }
      });
    }, { root, rootMargin: "1200px 0px" });
    let selectionFrame = 0;
    let wasSelecting = false;
    const reconsiderSelection = () => {
      const selection = document.getSelection();
      const inTranscript = !!selection && (root.contains(selection.anchorNode) || root.contains(selection.focusNode));
      if (!inTranscript && !wasSelecting) return;
      wasSelecting = inTranscript && !selection!.isCollapsed;
      if (selectionFrame) return;
      selectionFrame = requestAnimationFrame(() => {
        selectionFrame = 0;
        preserveTranscriptAnchor(root, () => {
          for (const [target, callback] of callbacks) {
            const entry = latest.get(target);
            if (entry) callback(entry);
          }
        });
      });
    };
    document.addEventListener("selectionchange", reconsiderSelection);
    viewport = { observer, callbacks, latest, dispose: () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", reconsiderSelection);
      if (selectionFrame) cancelAnimationFrame(selectionFrame);
    } };
    viewports.set(root, viewport);
  }
  viewport.callbacks.set(node, callback);
  viewport.observer.observe(node);
  return () => {
    viewport!.observer.unobserve(node);
    viewport!.callbacks.delete(node);
    viewport!.latest.delete(node);
    if (!viewport!.callbacks.size) { viewport!.dispose(); viewports.delete(root); }
  };
}

/** Keep user disclosure choices when offscreen turn contents leave the DOM. */
export function useTurnState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const saved = useContext(TurnState);
  const [value, setValue] = useState(() => saved?.has(key) ? saved.get(key) as T : initial);
  const update = useCallback((action: SetStateAction<T>) => {
    setValue((current) => {
      const next = typeof action === "function" ? (action as (value: T) => T)(current) : action;
      saved?.set(key, next);
      return next;
    });
  }, [key, saved]);
  return [value, update];
}

/** Native viewport observation avoids retaining heavy offscreen markdown/tool DOM. */
export function VirtualTranscriptTurn({ id, className, renderContent, root, enabled, forceMounted }: {
  id: string; className: string; renderContent: () => ReactNode;
  root: HTMLElement | null; enabled: boolean; forceMounted: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [choices] = useState(() => new Map<string, unknown>());
  const [nearViewport, setNearViewport] = useState(!enabled);
  const height = useRef(400);
  const mounted = !enabled || forceMounted || nearViewport || typeof IntersectionObserver === "undefined";
  useLayoutEffect(() => {
    const node = element.current;
    if (!enabled || !node || !root || typeof IntersectionObserver === "undefined") return;
    return observeViewport(root, node, (entry) => {
      if (entry.isIntersecting) { setNearViewport(true); return; }
      // Preserve in-progress native selection and keyboard focus. They may
      // temporarily keep extra turns mounted until the interaction finishes.
      const selection = document.getSelection();
      const selected = !!selection && !selection.isCollapsed &&
        Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
          .some((range) => range.intersectsNode(node));
      if (selected || node.contains(document.activeElement)) { setNearViewport(true); return; }
      setNearViewport(false);
    });
  }, [enabled, root]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!mounted || !node || !enabled) return;
    const measure = () => {
      const measured = node.getBoundingClientRect().height;
      if (measured > 0) height.current = measured;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted, enabled]);
  useLayoutEffect(() => {
    if (!mounted) return;
    const saved = choices.get("native-details") as boolean[] | undefined;
    if (saved) element.current?.querySelectorAll("details").forEach((details, index) => {
      if (saved[index] != null) details.open = saved[index];
    });
  }, [mounted, choices]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const capture = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement)
        choices.set("native-details", [...node.querySelectorAll("details")].map((details) => details.open));
    };
    node.addEventListener("toggle", capture, true);
    return () => node.removeEventListener("toggle", capture, true);
  }, [choices]);
  return <div ref={element} data-transcript-turn={id} data-turn-placeholder={!mounted || undefined}
    className={className} style={mounted ? undefined : { height: height.current }}>
    {mounted ? <TurnState.Provider value={choices}>{renderContent()}</TurnState.Provider> : null}
  </div>;
}
