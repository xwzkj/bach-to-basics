import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the component's mount effect with controllable browser lifecycle
// events; no GL driver or DOM package is needed to verify recovery scheduling.
const harness = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  refs: [] as any[],
  ready: vi.fn(),
  subscribe: vi.fn(),
  keyboards: [] as any[],
  pendingInit: null as Promise<void> | null,
  settings: {
    colorTheme: "custom",
    customColors: {},
    theme: "light",
    noteLabelMode: "c_only",
    pianoTheme: "white",
    showFingering: false,
    showHandColors: true,
    useFlats: false,
  },
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void) => {
    harness.effects.push(effect);
  },
  useRef: () => ({ current: harness.refs.shift() ?? null }),
  useState: () => [false, harness.ready],
}));
vi.mock("../store/useAppStore", () => ({
  useAppStore: Object.assign(() => ({ settings: harness.settings }), {
    subscribe: harness.subscribe,
  }),
  COLOR_PRESET_VALUES: {},
}));
vi.mock("../engine/SyncEngine", () => ({ syncEngine: { playMidi: vi.fn(), stopMidi: vi.fn() } }));
vi.mock("../components/PianoKeyboard/PianoKeyboard", () => ({
  PianoKeyboard: class {
    refresh = vi.fn(() => true);
    resize = vi.fn();
    reset = vi.fn();
    destroy = vi.fn();
    setOptions = vi.fn();
    constructor() {
      harness.keyboards.push(this);
    }
    async init() {
      if (harness.pendingInit) await harness.pendingInit;
    }
  },
}));

import { PianoKeyboardView } from "../components/PianoKeyboard/PianoKeyboardView";

let documentTarget: EventTarget & { visibilityState: string };
let windowTarget: EventTarget;
let canvas: EventTarget;
let frames: Map<number, FrameRequestCallback>;
let cleanup: (() => void) | undefined;
let unsubscribe: ReturnType<typeof vi.fn>;
function frame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}
async function mount() {
  PianoKeyboardView();
  cleanup = harness.effects[0]() as () => void;
  await Promise.resolve();
  await Promise.resolve();
  return harness.keyboards[0];
}

beforeEach(() => {
  frames = new Map();
  let frameId = 0;
  documentTarget = Object.assign(new EventTarget(), { visibilityState: "visible" });
  windowTarget = Object.assign(new EventTarget(), { innerWidth: 1000 });
  canvas = new EventTarget();
  harness.refs = [canvas, { clientWidth: 1000 }, null];
  harness.effects = [];
  harness.keyboards = [];
  harness.pendingInit = null;
  harness.ready.mockClear();
  unsubscribe = vi.fn();
  harness.subscribe.mockReset().mockReturnValue(unsubscribe);
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      frames.delete(id);
    })
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

describe("PianoKeyboardView lifecycle recovery", () => {
  it("coalesces focus/pageshow/visibility and successful import recovery", async () => {
    const kb = await mount();
    frame();
    kb.refresh.mockClear();
    windowTarget.dispatchEvent(new Event("focus"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    const onStoreChange = harness.subscribe.mock.calls[0][0];
    onStoreChange({ document: { id: "imported" } }, { document: null });
    expect(frames.size).toBe(1);
    frame();
    expect(kb.refresh).toHaveBeenCalledTimes(1);
    // Even without browser lifecycle events, an imported document triggers recovery.
    onStoreChange({ document: { id: "another" } }, { document: null });
    frame();
    expect(kb.refresh).toHaveBeenCalledTimes(2);
  });

  it("waits a frame after context restore and never rebuilds during context loss", async () => {
    const kb = await mount();
    frame();
    kb.refresh.mockClear();
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(harness.ready).toHaveBeenLastCalledWith(false);
    windowTarget.dispatchEvent(new Event("focus"));
    frame();
    expect(kb.refresh).not.toHaveBeenCalled();
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(kb.refresh).not.toHaveBeenCalled();
    frame();
    expect(kb.refresh).toHaveBeenCalledTimes(1);
    expect(harness.ready).toHaveBeenLastCalledWith(true);
  });

  it("cancels pending work on hide/unmount and removes all listeners", async () => {
    const kb = await mount();
    expect(frames.size).toBe(1);
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(1);
    cleanup?.();
    cleanup = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    windowTarget.dispatchEvent(new Event("focus"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    frame();
    expect(kb.refresh).not.toHaveBeenCalled();
    expect(kb.destroy).toHaveBeenCalledOnce();
  });

  it("ignores initialization resolving after unmount", async () => {
    let resolve!: () => void;
    harness.pendingInit = new Promise<void>((done) => {
      resolve = done;
    });
    const kb = await mount();
    cleanup?.();
    cleanup = undefined;
    harness.ready.mockClear();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    frame();
    expect(harness.ready).not.toHaveBeenCalled();
    expect(kb.refresh).not.toHaveBeenCalled();
    expect(kb.destroy).toHaveBeenCalledOnce();
  });
});
