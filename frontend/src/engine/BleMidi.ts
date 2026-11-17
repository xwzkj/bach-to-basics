/**
 * BLE MIDI 客户端（Web Bluetooth）
 *
 * 为什么不用 Web MIDI：Android 等系统不一定把 BLE-MIDI 设备暴露成系统 MIDI 端口，
 * Chrome 的 Web MIDI 就看不到它。这里直接连 GATT，自己解析 BLE-MIDI 包。
 *
 * 设备侧（例如 ESP32 的 BLE-MIDI）只需要实现标准的 MIDI Service：
 *   service        03B80E5A-EDE8-4B33-A751-6CE34EC4C700
 *   characteristic 7772E5DB-3868-4112-A1A9-F2669D106BF3（notify）
 *
 * 包格式：[header(0x80 | ts高6位)] [timestamp 低7位] [MIDI 消息...]
 */

const BLE_MIDI_SERVICE = "03b80e5a-ede8-4b33-a751-6ce34ec4c700";
const BLE_MIDI_CHARACTERISTIC = "7772e5db-3868-4112-a1a9-f2669d106bf3";

export type BleMidiEvents = {
  onNote: (midi: number, velocity: number) => void;
  onNoteOff: (midi: number) => void;
  onDisconnect: () => void;
};

type BluetoothLike = {
  requestDevice: (options: unknown) => Promise<unknown>;
};

type GattDevice = {
  name?: string | null;
  gatt?: {
    connect: () => Promise<{
      getPrimaryService: (uuid: string) => Promise<{
        getCharacteristic: (uuid: string) => Promise<GattCharacteristic>;
      }>;
    }>;
    disconnect: () => void;
  };
  addEventListener: (type: string, listener: () => void) => void;
};

type GattCharacteristic = {
  value?: DataView;
  startNotifications: () => Promise<unknown>;
  addEventListener: (type: string, listener: (event: { target: GattCharacteristic }) => void) => void;
  removeEventListener: (type: string, listener: (event: { target: GattCharacteristic }) => void) => void;
};

export function isBleMidiSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean((navigator as unknown as { bluetooth?: unknown }).bluetooth);
}

/**
 * 解析一个 BLE-MIDI 通知包，返回 [status, d1, d2?] 列表。
 * 只处理通道消息（音符/CC 等）；系统实时消息（时钟 0xF8 等）直接丢弃。
 */
export function parseBleMidiPacket(value: DataView): number[][] {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < 3) return [];

  // 前两个字节固定是 header + 时间戳。
  // 注意：真实设备（含 Apple/ESP32 实现）的时间戳字节最高位是 1（如 bf 9f …），
  // 不能靠 bit7 判断它是不是时间戳，否则会把 0x9f 当成 Note On 通道 16。
  let i = 2;

  const messages: number[][] = [];
  let runningStatus = 0;

  while (i < bytes.length) {
    let status: number;
    if (bytes[i] & 0x80) {
      status = bytes[i++];
      if (status >= 0xf0) break; // 系统消息（时钟/活动感知）不关心
      runningStatus = status;
    } else if (runningStatus) {
      status = runningStatus; // running status：同一包内连续同类型消息
    } else {
      break;
    }

    const type = status & 0xf0;
    const dataLen = type === 0xc0 || type === 0xd0 ? 1 : 2;
    const data: number[] = [];
    while (data.length < dataLen && i < bytes.length) {
      data.push(bytes[i++]);
    }
    if (data.length === dataLen) messages.push([status, ...data]);
  }

  return messages;
}

export class BleMidiConnection {
  private device: GattDevice | null = null;
  private characteristic: GattCharacteristic | null = null;
  private handler: ((event: { target: GattCharacteristic }) => void) | null = null;

  get deviceName(): string {
    return this.device?.name?.trim() || "BLE MIDI";
  }

  /**
   * 弹出浏览器的蓝牙设备选择框并连接。必须在用户手势（按钮点击）里调用。
   * 用 acceptAllDevices：不少 DIY / 廉价 BLE-MIDI 设备不在广播包里带 service UUID。
   */
  async connect(events: BleMidiEvents): Promise<string> {
    const bluetooth = (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth;
    if (!bluetooth) {
      throw new Error("这个浏览器不支持 Web Bluetooth（请用 Chrome/Edge，并且是 https）");
    }

    const device = (await bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_MIDI_SERVICE],
    })) as GattDevice;
    this.device = device;

    device.addEventListener("gattserverdisconnected", () => {
      this.characteristic = null;
      events.onDisconnect();
    });

    if (!device.gatt) throw new Error("这个蓝牙设备没有 GATT 服务");
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
    const characteristic = await service.getCharacteristic(BLE_MIDI_CHARACTERISTIC);
    this.characteristic = characteristic;

    this.handler = (event) => {
      const value = event.target.value;
      if (!value) return;
      for (const message of parseBleMidiPacket(value)) {
        const [status, d1, d2 = 0] = message;
        const type = status & 0xf0;
        if (type === 0x90 && d2 > 0) events.onNote(d1, d2);
        else if (type === 0x80 || (type === 0x90 && d2 === 0)) events.onNoteOff(d1);
      }
    };

    characteristic.addEventListener("characteristicvaluechanged", this.handler);
    await characteristic.startNotifications();

    return this.deviceName;
  }

  disconnect(): void {
    try {
      if (this.characteristic && this.handler) {
        this.characteristic.removeEventListener("characteristicvaluechanged", this.handler);
      }
    } catch {
      /* 设备可能已经走了 */
    }
    this.handler = null;
    this.characteristic = null;
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.device = null;
  }
}
