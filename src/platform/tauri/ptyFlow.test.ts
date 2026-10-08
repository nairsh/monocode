import { afterEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, handler);
    return () => bridge.listeners.delete(name);
  }),
}));
import { killAllPtys, subscribePty } from "./pty";

afterEach(async () => {
  await killAllPtys();
  bridge.invoke.mockClear();
});

function emit(sequence: number, id = "terminal") {
  bridge.listeners.get("pty-data")!({ payload: { id, pid: 42, sequence, data: "8J+YgBtbMzFt" } });
}

it("acknowledges exact byte chunks only after the renderer consumes them", () => {
  let consumed!: () => void;
  let received!: Uint8Array;
  const unsubscribe = subscribePty("terminal", (data, done) => { received = data; consumed = done; }, () => {});
  emit(1);
  expect(Array.from(received)).toEqual([240, 159, 152, 128, 27, 91, 51, 49, 109]);
  expect(bridge.invoke).not.toHaveBeenCalled();
  consumed();
  consumed();
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("pty_ack", { id: "terminal", pid: 42, sequence: 1 });
  unsubscribe();
});

it("releases pending consumption on detach and accepts bounded replay without stalling a background shell", () => {
  const callbacks: (() => void)[] = [];
  const unsubscribe = subscribePty("terminal", (_data, done) => { callbacks.push(done); }, () => {});
  emit(1);
  emit(2);
  unsubscribe();
  expect(bridge.invoke).toHaveBeenCalledTimes(2);
  callbacks.forEach((done) => done());
  expect(bridge.invoke).toHaveBeenCalledTimes(2);
  emit(3);
  expect(bridge.invoke).toHaveBeenCalledTimes(3);
  emit(4, "another-window");
  expect(bridge.invoke).toHaveBeenCalledTimes(3);
  const replay = vi.fn((_data: Uint8Array, done: () => void) => done());
  const stop = subscribePty("terminal", replay, () => {});
  expect(replay).toHaveBeenCalledOnce();
  expect(bridge.invoke).toHaveBeenCalledTimes(3);
  stop();
});

it("keeps the bridge alive for an opened background PTY after its view detaches", async () => {
  vi.useFakeTimers();
  try {
    const detach = subscribePty("terminal", (_data, done) => done(), () => {});
    detach();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.listeners.has("pty-data")).toBe(true);
    emit(10);
    expect(bridge.invoke).toHaveBeenCalledWith("pty_ack", { id: "terminal", pid: 42, sequence: 10 });
    await killAllPtys();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.listeners.has("pty-data")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
