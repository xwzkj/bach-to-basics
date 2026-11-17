import { useEffect, useRef, useState } from "react";
import { WebMidi } from "webmidi";
import { syncEngine } from "../../engine/SyncEngine";
import { BleMidiConnection, isBleMidiSupported } from "../../engine/BleMidi";
import { useAppStore } from "../../store/useAppStore";

type InputPort = NonNullable<ReturnType<typeof WebMidi.getInputByName>>;

const POPOVER_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  minWidth: 220,
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  zIndex: 100,
  overflow: "hidden",
};

/** ALSA 的 "Midi Through"、各种虚拟回环端口：能列出来，但收到的不是琴的按键 */
const isLoopback = (name: string) => /through|loopback/i.test(name);

type PortInfo = { id: string; name: string };

/** 端口名可能为空（某些 BLE/虚拟设备），显示时要给个能点的标签 */
const portLabel = (port: { name?: string | null }) => port.name?.trim() || "(未命名 MIDI 设备)";

const listInputs = (): PortInfo[] =>
  WebMidi.inputs
    .map((i) => ({ id: i.id, name: portLabel(i) }))
    .sort((a, b) => Number(isLoopback(a.name)) - Number(isLoopback(b.name)));

const findInputById = (id: string | null) =>
  (id ? WebMidi.inputs.find((i) => i.id === id) : undefined) ?? null;

export function DevicePanel() {
  const [inputs, setInputs] = useState<PortInfo[]>([]);
  const [midiStatus, setMidiStatus] = useState<"idle" | "enabled" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // 琴会持续发 MIDI 时钟（0xF8），拿它当“链路还活着”的心跳：
  // 时钟停了 = USB 那边不发了，跟浏览器/监听无关。
  const [stalled, setStalled] = useState(false);
  const [bleName, setBleName] = useState<string | null>(null);
  const [bleError, setBleError] = useState<string | null>(null);
  const bleRef = useRef<BleMidiConnection | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const attachedRef = useRef<InputPort | null>(null);
  const lastMsgRef = useRef(0);
  const sawClockRef = useRef(false);
  const { midiDeviceName, setMidiDevice } = useAppStore();
  // effect 里的监听器拿不到最新的 midiDeviceName，用 ref 同步一份
  const selectedRef = useRef<string | null>(midiDeviceName);
  useEffect(() => {
    selectedRef.current = midiDeviceName;
  }, [midiDeviceName]);
  // 端口名可能是空字符串，按名字查会失败；选中状态一律按端口 id 记
  const selectedIdRef = useRef<string | null>(null);

  // 挂接一个输入端口；重复调用会先摘掉旧的，避免重复监听
  const attachInput = (input: InputPort) => {
    try {
      attachedRef.current?.removeListener();
    } catch {
      /* 端口可能已经没了 */
    }
    const beat = () => {
      lastMsgRef.current = Date.now();
    };
    input.addListener("clock", () => {
      sawClockRef.current = true;
      beat();
    });
    input.addListener("noteon", (e) => {
      beat();
      syncEngine.onMidiInput(e.note.number, e.rawValue ?? 64);
    });
    input.addListener("noteoff", (e) => {
      beat();
      syncEngine.onMidiInputOff(e.note.number);
    });
    lastMsgRef.current = Date.now();
    attachedRef.current = input;
  };

  useEffect(() => {
    WebMidi.enable({ sysex: false })
      .then(() => {
        setMidiStatus("enabled");
        setInputs(listInputs());
        WebMidi.addListener("connected", () => {
          setInputs(listInputs());
          // USB 掉线再插回来时，同名端口会变成新对象，必须重新挂监听，
          // 否则界面还显示“已连接”，实际一个音符都收不到。
          const id = selectedIdRef.current;
          if (!id) return;
          const again = findInputById(id);
          if (again) attachInput(again);
        });
        WebMidi.addListener("disconnected", () => {
          setInputs(listInputs());
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(
          !navigator.requestMIDIAccess
            ? "Web MIDI not supported. Use Chrome or Edge."
            : `MIDI access denied. Check browser permissions. (${msg})`
        );
        setMidiStatus("error");
      });

    return () => {
      try { WebMidi.removeListener("connected"); } catch {}
      try { WebMidi.removeListener("disconnected"); } catch {}
      bleRef.current?.disconnect();
      bleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 看门狗：只在“曾经收到过时钟”的前提下判断，避免对不发时钟的琴误报
  useEffect(() => {
    const timer = setInterval(() => {
      if (!midiDeviceName || !sawClockRef.current) return;
      setStalled(Date.now() - lastMsgRef.current > 8000);
    }, 2000);
    return () => clearInterval(timer);
  }, [midiDeviceName]);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        !chipRef.current?.contains(e.target as Node) &&
        !popoverRef.current?.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  /** 连接 BLE-MIDI 设备（Web Bluetooth，必须在点击事件里调用） */
  const connectBle = async () => {
    setBleError(null);
    if (!isBleMidiSupported()) {
      setBleError("这个浏览器不支持 Web Bluetooth，请用 Chrome/Edge");
      return;
    }
    try {
      // 先摘掉有线输入，避免同一个琴既走 USB 又走蓝牙时重复触发
      try { attachedRef.current?.removeListener(); } catch { /* ignore */ }
      attachedRef.current = null;
      sawClockRef.current = false;   // BLE 不发时钟，别让看门狗误报

      const conn = new BleMidiConnection();
      const name = await conn.connect({
        onNote: (midi, velocity) => {
          lastMsgRef.current = Date.now();
          syncEngine.onMidiInput(midi, velocity);
        },
        onNoteOff: (midi) => {
          lastMsgRef.current = Date.now();
          syncEngine.onMidiInputOff(midi);
        },
        onDisconnect: () => {
          bleRef.current = null;
          setBleName(null);
          setMidiDevice(null);
        },
      });
      bleRef.current = conn;
      setBleName(name);
      setMidiDevice(`BLE: ${name}`);
      setOpen(false);
    } catch (err) {
      setBleError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 掉线后点 chip：摘掉旧监听、重新拿一次 access、再挂上（能救回“假死”的端口） */
  const reconnect = () => {
    const id = selectedIdRef.current;
    if (!id) return;
    setStalled(false);
    lastMsgRef.current = Date.now();
    const input = findInputById(id);
    if (input) {
      attachInput(input);
      return;
    }
    // 端口对象已经不在了：重新 enable 一次，等它重新枚举
    try { WebMidi.disable(); } catch { /* ignore */ }
    WebMidi.enable({ sysex: false })
      .then(() => {
        setInputs(listInputs());
        const again = findInputById(id);
        if (again) attachInput(again);
      })
      .catch(() => setStalled(true));
  };

  const connectDevice = (id: string) => {
    const input = findInputById(id);
    if (!input) return;
    attachInput(input);
    selectedIdRef.current = id;
    sawClockRef.current = false;
    setMidiDevice(portLabel(input));
    setOpen(false);
  };

  const disconnect = () => {
    if (bleRef.current) {
      bleRef.current.disconnect();
      bleRef.current = null;
      setBleName(null);
    }
    try {
      attachedRef.current?.removeListener();
    } catch {
      /* ignore */
    }
    attachedRef.current = null;
    selectedIdRef.current = null;
    setMidiDevice(null);
    setOpen(false);
  };

  // Error state：Web MIDI 不可用时，仍然允许走蓝牙这条路
  if (midiStatus === "error") {
    return (
      <div className="relative shrink-0">
        <button
          ref={chipRef}
          onClick={() => setOpen((v) => !v)}
          title={errorMsg ?? "MIDI error"}
          className="midi-chip text-xs px-2 py-1 rounded cursor-help shrink-0"
          style={{
            color: "var(--color-warning)",
            background: "var(--color-warning-subtle)",
            border: "1px solid var(--color-warning-border)",
          }}
        >
          ⚠<span className="midi-chip-label"> MIDI</span>
        </button>
        {open && (
          <div ref={popoverRef} style={POPOVER_STYLE}>
            <div className="px-3 py-2 text-xs" style={{ color: "#f87171", lineHeight: 1.4 }}>
              {errorMsg}
            </div>
            <div style={{ borderTop: "1px solid var(--color-border)", padding: "4px 0" }}>
              <div
                className="px-3 py-1 text-xs font-semibold uppercase tracking-wide"
                style={{ color: "var(--color-text-muted)" }}
              >
                Bluetooth LE MIDI
              </div>
              <button
                onClick={connectBle}
                className="w-full text-left px-3 py-2 text-xs"
                style={{
                  background: bleName ? "rgba(99,102,241,0.12)" : "transparent",
                  color: bleName ? "var(--color-accent)" : "var(--color-text)",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {bleName ? `已连接：${bleName}` : "连接蓝牙 MIDI 设备…"}
              </button>
              {bleError && (
                <div className="px-3 pt-1 text-xs" style={{ color: "#f87171", lineHeight: 1.4 }}>
                  {bleError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Not yet initialized
  if (midiStatus === "idle") return null;

  const connected = !!midiDeviceName;
  const dead = connected && stalled;

  return (
    <div className="relative shrink-0">
      {/* Chip button */}
      <button
        ref={chipRef}
        onClick={() => {
          if (dead) {
            reconnect();
            return;
          }
          setOpen((v) => !v);
        }}
        title={
          dead
            ? "设备 8 秒没有发数据（连时钟都停了）——USB 链路断了，点这里重连"
            : connected
              ? `Connected: ${midiDeviceName}`
              : "Select MIDI input device"
        }
        className="midi-chip flex items-center gap-2 text-xs font-semibold transition-colors shrink-0"
        style={{
          background: dead
            ? "rgba(239,68,68,0.10)"
            : connected
              ? "rgba(34,197,94,0.08)"
              : "var(--color-warning-subtle)",
          border: dead
            ? "1px solid rgba(239,68,68,0.6)"
            : connected
              ? "1px solid rgba(34,197,94,0.5)"
              : "1px solid var(--color-warning-border)",
          color: dead ? "#f87171" : connected ? "#4ade80" : "var(--color-warning)",
          cursor: "pointer",
          borderRadius: 999,
          fontSize: 12,
          padding: connected ? "4px 10px" : "5px 12px",
        }}
      >
        {connected ? (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: "#4ade80", boxShadow: "0 0 6px #4ade80" }}
          />
        ) : (
          <span style={{ fontSize: 11, lineHeight: 1, flexShrink: 0 }}>⚠</span>
        )}
        <span
          className="truncate"
          style={{ maxWidth: 130 }}
        >
          {dead
            ? "设备无数据 · 点此重连"
            : connected
              ? midiDeviceName?.trim() || "MIDI 设备"
              : "No MIDI device"}
        </span>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.5, flexShrink: 0 }}>
          <path d="M7 10l5 5 5-5z"/>
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <div
          ref={popoverRef}
          style={POPOVER_STYLE}
        >
          <div
            className="px-3 py-2 text-xs font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-text-muted)", borderBottom: "1px solid var(--color-border)" }}
          >
            MIDI Input
          </div>

          {inputs.length === 0 ? (
            <div className="px-3 py-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
              No MIDI devices found.
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: "4px 0" }}>
              {inputs.map((port) => {
                const isActive = port.id === selectedIdRef.current || port.name === midiDeviceName;
                return (
                  <li key={port.id}>
                    <button
                      onClick={() => connectDevice(port.id)}
                      className="w-full text-left px-3 py-2 text-xs transition-colors flex items-center gap-2"
                      style={{
                        background: isActive ? "rgba(99,102,241,0.12)" : "transparent",
                        color: isActive ? "var(--color-accent)" : "var(--color-text)",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: isActive ? "#4ade80" : "var(--color-border)" }}
                      />
                      <span className="truncate">{port.name}</span>
                      {isActive && (
                        <span className="ml-auto text-xs" style={{ color: "#4ade80" }}>✓</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* 蓝牙 MIDI（Web Bluetooth）：系统不把 BLE-MIDI 暴露成 MIDI 端口时用这条路 */}
          <div style={{ borderTop: "1px solid var(--color-border)", padding: "4px 0" }}>
            <div
              className="px-3 py-1 text-xs font-semibold uppercase tracking-wide"
              style={{ color: "var(--color-text-muted)" }}
            >
              Bluetooth LE MIDI
            </div>
            <button
              onClick={connectBle}
              className="w-full text-left px-3 py-2 text-xs transition-colors"
              style={{
                background: bleName ? "rgba(99,102,241,0.12)" : "transparent",
                color: bleName ? "var(--color-accent)" : "var(--color-text)",
                border: "none",
                cursor: "pointer",
              }}
            >
              {bleName ? `已连接：${bleName}` : "连接蓝牙 MIDI 设备…"}
            </button>
            {bleError && (
              <div className="px-3 pt-1 text-xs" style={{ color: "#f87171", lineHeight: 1.4 }}>
                {bleError}
              </div>
            )}
          </div>

          {connected && (
            <div style={{ borderTop: "1px solid var(--color-border)", padding: "4px 0" }}>
              <button
                onClick={disconnect}
                className="w-full text-left px-3 py-2 text-xs transition-colors"
                style={{ background: "transparent", color: "#f87171", border: "none", cursor: "pointer" }}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
