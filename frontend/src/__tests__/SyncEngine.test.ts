import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicDocument, NoteEvent } from "@bach-to-basics/shared";

const mocks = vi.hoisted(() => {
  const clock = {
    currentSeconds: 0,
    tempoMultiplier: 1,
    onTick: vi.fn(),
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    reschedule: vi.fn(),
  };
  const transport = { cancel: vi.fn(), scheduleOnce: vi.fn() };
  const audio = {
    load: vi.fn().mockResolvedValue(undefined),
    wake: vi.fn(),
    stopAll: vi.fn(),
    playNote: vi.fn(),
    stopNote: vi.fn(),
  };
  return { clock, transport, audio };
});

vi.mock("tone", () => ({
  getTransport: () => mocks.transport,
  start: vi.fn(),
}));
vi.mock("../engine/MidiClock", () => ({
  MidiClock: class {
    constructor() {
      return mocks.clock;
    }
  },
}));
vi.mock("../engine/AudioEngine", () => ({
  AudioEngine: class {
    constructor() {
      return mocks.audio;
    }
  },
}));

function note(midi: number, startSeconds = 0, hand: NoteEvent["hand"] = "right"): NoteEvent {
  return {
    id: `${midi}-${startSeconds}-${hand}`,
    midi,
    pitch: "",
    startTick: 0,
    durationTick: 480,
    startSeconds,
    endSeconds: startSeconds + 0.4,
    hand,
    finger: null,
    velocity: 90,
    channel: 0,
  };
}
function document(notes: NoteEvent[]): MusicDocument {
  return {
    id: "test",
    title: "test",
    sourceType: "midi",
    notes,
    musicXml: null,
    midiBuffer: null,
    tempoMap: [{ tick: 0, bpm: 120 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    totalDuration: 10,
    ppq: 480,
    keySignature: null,
    youtubeId: null,
    youtubeSyncOffset: 0,
    fingeringVersion: "none",
  };
}

let engine: (typeof import("../engine/SyncEngine"))["syncEngine"];
let tick: (seconds: number) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  mocks.clock.currentSeconds = 0;
  mocks.clock.tempoMultiplier = 1;
  engine = (await import("../engine/SyncEngine")).syncEngine;
  const onTick = mocks.clock.onTick.mock.calls[0][0] as (seconds: number) => void;
  tick = (seconds) => {
    mocks.clock.currentSeconds = seconds;
    onTick(seconds);
  };
  // Real clocks can invoke the first tick before start() resolves.
  mocks.clock.start.mockImplementation(async (seconds: number) => tick(seconds));
});

async function startWaiting(notes: NoteEvent[]) {
  await engine.loadDocument(document(notes));
  engine.setWaitMode(true);
  await engine.play();
}

describe("SyncEngine wait mode", () => {
  it.each([
    ["left", true],
    ["left", false],
    ["right", true],
    ["right", false],
  ] as const)(
    "plays the other hand once when practising %s (target first: %s)",
    async (hand, targetFirst) => {
      engine.setWaitForHand(hand);
      const target = note(hand === "left" ? 48 : 72, 0, hand);
      const accompaniment = note(hand === "left" ? 72 : 48, 0, hand === "left" ? "right" : "left");
      await startWaiting(targetFirst ? [target, accompaniment] : [accompaniment, target]);
      expect(engine.state.status).toBe("waiting");
      engine.onMidiInput(target.midi, 90);
      expect(engine.state.status).toBe("playing");
      // Due note-on must happen without relying on a paused Transport's +0 tick.
      expect(mocks.audio.playNote).toHaveBeenCalledExactlyOnceWith(accompaniment);
      expect(mocks.transport.scheduleOnce).toHaveBeenCalledTimes(1);
      mocks.transport.scheduleOnce.mock.calls[0][0]();
      expect(mocks.audio.stopNote).toHaveBeenCalledWith(accompaniment.midi);
      tick(0.125);
      expect(mocks.audio.playNote).toHaveBeenCalledTimes(1);
      expect(mocks.transport.scheduleOnce).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves the accompaniment timing, transpose and volume after waiting", async () => {
    engine.setWaitForHand("left");
    engine.setTranspose(2);
    engine.setTempoMultiplier(0.5);
    engine.setHandVolume({ left: 1, right: 0.5 });
    await startWaiting([note(48, 0, "left"), note(72, 0.04, "right")]);
    engine.onMidiInput(50, 90);
    expect(mocks.transport.scheduleOnce.mock.calls[0][1]).toBe("+0.08");
    mocks.transport.scheduleOnce.mock.calls[0][0]();
    expect(mocks.audio.playNote).toHaveBeenCalledWith(
      expect.objectContaining({ midi: 74, velocity: 45 })
    );
  });

  it("keeps an explicitly muted accompaniment hand silent", async () => {
    engine.setWaitForHand("left");
    engine.setActiveHands(new Set(["left"]));
    await startWaiting([note(48, 0, "left"), note(72, 0, "right")]);
    engine.onMidiInput(48, 90);
    mocks.transport.scheduleOnce.mock.calls[0][0]();
    expect(mocks.audio.playNote).not.toHaveBeenCalled();
  });

  it("waits on the first tick and requires every chord pitch, in any order", async () => {
    await startWaiting([note(60), note(64), note(67), note(72, 1)]);
    expect(engine.state.status).toBe("waiting");
    expect(mocks.transport.scheduleOnce).not.toHaveBeenCalled();
    engine.onMidiInput(61, 90);
    engine.onMidiInput(67, 90);
    engine.onMidiInput(67, 90);
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(64, 0);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(64, 90);
    expect(engine.state.status).toBe("playing");
    expect(mocks.clock.resume).toHaveBeenCalledTimes(1);
    tick(0.125);
    expect(engine.state.status).toBe("playing");
    tick(1);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(72, 90);
    expect(engine.state.status).toBe("playing");
  });

  it.each([0.25, 1, 2])("never schedules past a target 55ms ahead at tempo %s", async (tempo) => {
    await engine.loadDocument(document([note(60, 0.055)]));
    engine.setTempoMultiplier(tempo);
    engine.setWaitMode(true);
    await engine.play();
    expect(engine.state.status).toBe("waiting");
    expect(mocks.transport.scheduleOnce).not.toHaveBeenCalled();
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("matches transposed pitches and deduplicates pitches clamped to the piano range", async () => {
    engine.setTranspose(12);
    await startWaiting([note(60), note(100), note(106)]);
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(72, 90);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(108, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("resumes when disabled and allows the waiting onset to be scheduled normally", async () => {
    await startWaiting([note(60)]);
    engine.setWaitMode(false);
    expect(engine.state.status).toBe("playing");
    expect(mocks.clock.resume).toHaveBeenCalledTimes(1);
    tick(0);
    expect(mocks.audio.playNote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ midi: 60 }));
    expect(mocks.transport.scheduleOnce).toHaveBeenCalledTimes(1);
    engine.onMidiInput(60, 90);
    expect(mocks.clock.resume).toHaveBeenCalledTimes(1);
  });

  it("cancels the long audio queue when enabled during playback", async () => {
    await engine.loadDocument(document([note(60, 2)]));
    await engine.play();
    expect(mocks.transport.scheduleOnce).toHaveBeenCalledTimes(2);
    mocks.clock.currentSeconds = 0.5;
    engine.setWaitMode(true);
    expect(mocks.transport.cancel).toHaveBeenCalled();
    expect(mocks.audio.stopAll).toHaveBeenCalled();
    expect(mocks.clock.reschedule).toHaveBeenCalledWith(0.5);
    tick(2);
    expect(engine.state.status).toBe("waiting");
  });

  it("also cancels the old audio queue when enabled while manually paused", async () => {
    await engine.loadDocument(document([note(60, 2)]));
    await engine.play();
    engine.pause();
    engine.setWaitMode(true);
    expect(mocks.transport.cancel).toHaveBeenCalled();
    expect(engine.state.status).toBe("paused");
    await engine.play();
    tick(2);
    expect(engine.state.status).toBe("waiting");
  });

  it("clears partial chord progress and stale targets on seek and stop", async () => {
    await startWaiting([note(60), note(64), note(72, 2)]);
    engine.onMidiInput(60, 90);
    engine.seek(2);
    tick(2);
    engine.onMidiInput(64, 90);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(72, 90);
    expect(engine.state.status).toBe("playing");
    engine.stop();
    await engine.play();
    engine.onMidiInput(64, 90);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("playing");
    engine.stop();
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("stopped");
  });

  it("recomputes chord targets on wait-hand changes without losing confirmed pitches", async () => {
    await startWaiting([note(48, 0, "left"), note(60), note(64)]);
    engine.onMidiInput(60, 90);
    engine.setWaitForHand("right");
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(64, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("releases an impossible waiting group after its hand is disabled", async () => {
    await startWaiting([note(48, 0, "left"), note(60, 1)]);
    engine.setActiveHands(new Set(["right"]));
    expect(engine.state.status).toBe("playing");
    tick(1);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("adds the newly selected hand to the current chord targets", async () => {
    engine.setWaitForHand("left");
    await startWaiting([note(48, 0, "left"), note(60)]);
    engine.setWaitForHand("right");
    engine.onMidiInput(48, 90);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("preserves a waiting state reached synchronously while resuming after seek", async () => {
    await startWaiting([note(60), note(72, 2)]);
    mocks.clock.resume.mockImplementationOnce(() => tick(2));
    engine.seek(2);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(72, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("rechecks the current onset when tempo changes while waiting", async () => {
    await startWaiting([note(60)]);
    mocks.clock.resume.mockImplementationOnce(() => tick(0));
    engine.setTempoMultiplier(0.5);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("updates pending pitches when transposition changes while waiting", async () => {
    await startWaiting([note(60), note(64)]);
    engine.onMidiInput(60, 90);
    engine.setTranspose(2);
    engine.onMidiInput(64, 90);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(62, 90);
    engine.onMidiInput(66, 90);
    expect(engine.state.status).toBe("playing");
  });

  it("still waits for unknown-hand notes with a single hand selected", async () => {
    engine.setWaitForHand("left");
    await startWaiting([note(60, 0, "unknown")]);
    expect(engine.state.status).toBe("waiting");
    engine.onMidiInput(60, 90);
    expect(engine.state.status).toBe("playing");
  });
});
