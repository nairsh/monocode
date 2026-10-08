import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const UNITS: [number, string][] = [
  [365 * 24 * 60, "y"],
  [7 * 24 * 60, "w"],
  [24 * 60, "d"],
  [60, "h"],
  [1, "m"],
];

/** Compact age such as `5m ago`; under a minute reads `now`. */
export function shortAgo(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / MINUTE);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  const [size, unit] = UNITS.find(([size]) => minutes >= size)!;
  return `${Math.floor(minutes / size)}${unit} ago`;
}

// One shared timer for every subscriber, running only while something listens.
let minute = Math.floor(Date.now() / MINUTE);
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  minute = Math.floor(Date.now() / MINUTE);
  listeners.add(listener);
  timer ??= setInterval(() => {
    const next = Math.floor(Date.now() / MINUTE);
    if (next === minute) return;
    minute = next;
    for (const notify of listeners) notify();
  }, 10_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = undefined;
  };
}

/** Current time, re-rendering once a minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, () => minute) * MINUTE;
}
