import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pixi = vi.hoisted(() => ({
  gradients: [] as { destroyed: boolean; destroy: () => void }[],
  applications: [] as any[],
  pendingInit: null as Promise<void> | null,
}));

vi.mock("pixi.js", () => {
  class Container {
    children: any[] = [];
    destroyed = false;
    x = 0;
    y = 0;
    addChild(...children: any[]) {
      this.children.push(...children);
    }
    removeChildren() {
      return this.children.splice(0);
    }
    on() {
      return this;
    }
    destroy(options?: { children?: boolean }) {
      this.destroyed = true;
      if (options?.children) for (const child of this.removeChildren()) child.destroy(options);
    }
  }
  class Graphics extends Container {
    fills: any[] = [];
    clear() {
      this.fills = [];
      return this;
    }
    roundRect() {
      return this;
    }
    rect() {
      return this;
    }
    fill(value: any) {
      this.fills.push(value);
      return this;
    }
    stroke() {
      return this;
    }
  }
  class Text extends Container {
    anchor = { set: vi.fn() };
    text: string;
    constructor(options: { text: string }) {
      super();
      this.text = options.text;
    }
  }
  class FillGradient {
    destroyed = false;
    destroy() {
      this.destroyed = true;
    }
    constructor() {
      pixi.gradients.push(this);
    }
  }
  class Application {
    stage = new Container();
    renderer = { resize: vi.fn() };
    render = vi.fn();
    destroy = vi.fn();
    constructor() {
      pixi.applications.push(this);
    }
    async init() {
      if (pixi.pendingInit) await pixi.pendingInit;
    }
  }
  return { Application, Container, Graphics, Text, FillGradient };
});

import { PianoKeyboard } from "../components/PianoKeyboard/PianoKeyboard";

const canvas = {} as HTMLCanvasElement;
function createKeyboard() {
  return new PianoKeyboard(canvas, {
    width: 1040,
    height: 160,
    noteLabelMode: "c_only",
    pianoTheme: "white",
    showFingering: true,
    showHandColors: true,
    useFlats: false,
  });
}
function whiteKeys(app: any) {
  return app.stage.children[0].children[0].children;
}

beforeEach(() => {
  pixi.gradients = [];
  pixi.applications = [];
  pixi.pendingInit = null;
  vi.stubGlobal("window", {
    devicePixelRatio: 2,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("PianoKeyboard resource recovery", () => {
  it("replaces cached gradients and destroys old keys while preserving held-note state", async () => {
    const kb = createKeyboard();
    await kb.init(canvas);
    kb.inputNoteOn(21);
    const app = pixi.applications[0];
    const oldRoot = app.stage.children[0];
    const oldKeys = [...whiteKeys(app)];
    const oldGradients = [...pixi.gradients];

    expect(kb.refresh()).toBe(true);
    expect(oldRoot.destroyed).toBe(true);
    expect(oldKeys.every((key: any) => key.destroyed)).toBe(true);
    expect(oldGradients.every((gradient) => gradient.destroyed)).toBe(true);
    expect(whiteKeys(app)[0].y).toBe(5); // A0 remains held after rebuilding.
    expect(pixi.gradients.slice(oldGradients.length).every((gradient) => !gradient.destroyed)).toBe(
      true
    );
    expect(app.stage.children).toHaveLength(1);
    expect(app.render).toHaveBeenCalledTimes(2);
    kb.inputNoteOff(21);
    expect(whiteKeys(app)[0].y).toBe(0);
    kb.destroy();
  });

  it("uses size updates made during async initialization", async () => {
    let resolve!: () => void;
    pixi.pendingInit = new Promise<void>((done) => {
      resolve = done;
    });
    const kb = createKeyboard();
    const initialized = kb.init(canvas);
    kb.resize(780, 160);
    resolve();
    await initialized;
    expect(pixi.applications[0].renderer.resize).toHaveBeenLastCalledWith(780, 160);
    kb.destroy();
  });

  it("destroys a late async renderer without attaching listeners or drawing", async () => {
    let resolve!: () => void;
    pixi.pendingInit = new Promise<void>((done) => {
      resolve = done;
    });
    const kb = createKeyboard();
    const initialized = kb.init(canvas);
    kb.destroy();
    resolve();
    await initialized;
    const app = pixi.applications[0];
    expect(app.destroy).toHaveBeenCalledTimes(1);
    expect(window.addEventListener).not.toHaveBeenCalled();
    expect(app.render).not.toHaveBeenCalled();
    expect(kb.refresh()).toBe(false);
    kb.destroy();
    expect(app.destroy).toHaveBeenCalledTimes(1);
  });

  it("releases gradients and makes subsequent recovery harmless after destroy", async () => {
    const kb = createKeyboard();
    await kb.init(canvas);
    kb.destroy();
    kb.destroy();
    const app = pixi.applications[0];
    expect(pixi.gradients.every((gradient) => gradient.destroyed)).toBe(true);
    expect(app.stage.children).toHaveLength(0);
    expect(app.destroy).toHaveBeenCalledTimes(1);
    expect(kb.refresh()).toBe(false);
    kb.resize(780, 160);
    expect(app.renderer.resize).toHaveBeenCalledTimes(1);
  });
});
