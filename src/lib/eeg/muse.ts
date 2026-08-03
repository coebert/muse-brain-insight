/// <reference types="web-bluetooth" />
/**
 * Muse 2 (and Muse S / Muse 2016) Web Bluetooth client.
 * Streams the four scalp electrodes at 256 Hz.
 */

export const MUSE_SERVICE = "0000fe8d-0000-1000-8000-00805f9b34fb";
const CONTROL_CHAR = "273e0001-4c4d-454d-96be-f03bac821358";

export const MUSE_CHANNELS = ["TP9", "AF7", "AF8", "TP10"] as const;
export type MuseChannel = (typeof MUSE_CHANNELS)[number];

const EEG_CHARS: Record<MuseChannel, string> = {
  TP9: "273e0003-4c4d-454d-96be-f03bac821358",
  AF7: "273e0004-4c4d-454d-96be-f03bac821358",
  AF8: "273e0005-4c4d-454d-96be-f03bac821358",
  TP10: "273e0006-4c4d-454d-96be-f03bac821358",
};

export type SampleHandler = (channel: MuseChannel, samples: Float64Array) => void;

/** Connection lifecycle reported to the UI so a dropout is never silent. */
export type SourceState =
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number; attempts: number }
  | { kind: "lost"; reason: string };

export type SourceStateHandler = (state: SourceState) => void;

export interface EegSource {
  readonly name: string;
  start(onSamples: SampleHandler): Promise<void>;
  stop(): Promise<void>;
  onDisconnect(cb: () => void): void;
  /** Optional: reports reconnection attempts while the case continues. */
  onState?(cb: SourceStateHandler): void;
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/** Muse packets carry 12 samples packed as 12-bit unsigned integers. */
export function decodeMusePacket(data: DataView): Float64Array {
  const out = new Float64Array(12);
  let bitOffset = 16; // first 16 bits are the packet index
  for (let i = 0; i < 12; i++) {
    const byte = bitOffset >> 3;
    const shift = bitOffset & 7;
    const raw =
      (((data.getUint8(byte) << 16) | (data.getUint8(byte + 1) << 8) | data.getUint8(byte + 2)) >>
        (12 - shift)) &
      0xfff;
    // 0.48828125 µV per LSB, centred on 2048.
    out[i] = 0.48828125 * (raw - 2048);
    bitOffset += 12;
  }
  return out;
}

export class MuseClient implements EegSource {
  name = "Muse";
  private device: BluetoothDevice | null = null;
  private control: BluetoothRemoteGATTCharacteristic | null = null;
  private disconnectCb: (() => void) | null = null;
  private stateCb: SourceStateHandler | null = null;
  private samplesCb: SampleHandler | null = null;
  private stopping = false;
  private reconnecting = false;
  /** Exponential backoff, seconds, between reconnection attempts. */
  private static readonly RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

  onDisconnect(cb: () => void) {
    this.disconnectCb = cb;
  }

  onState(cb: SourceStateHandler) {
    this.stateCb = cb;
  }

  private async send(command: string) {
    if (!this.control) return;
    const encoded = new Uint8Array(command.length + 2);
    encoded[0] = command.length + 1;
    for (let i = 0; i < command.length; i++) encoded[i + 1] = command.charCodeAt(i);
    encoded[command.length + 1] = 0x0a;
    await this.control.writeValue(encoded);
  }

  async start(onSamples: SampleHandler) {
    if (!isWebBluetoothAvailable()) {
      throw new Error(
        "Web Bluetooth is unavailable in this browser. Use Chrome or Edge on desktop or Android.",
      );
    }
    this.stopping = false;
    this.samplesCb = onSamples;
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Muse" }],
      optionalServices: [MUSE_SERVICE],
    });
    this.device = device;
    this.name = device.name ?? "Muse";
    device.addEventListener("gattserverdisconnected", () => {
      if (this.stopping) return;
      void this.attemptReconnect();
    });

    await this.attach();
  }

  /** (Re)opens GATT and re-subscribes to the four electrode characteristics. */
  private async attach() {
    const device = this.device;
    const onSamples = this.samplesCb;
    if (!device || !onSamples) throw new Error("The headband is no longer available.");
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(MUSE_SERVICE);
    this.control = await service.getCharacteristic(CONTROL_CHAR);
    await this.control.startNotifications();

    for (const channel of MUSE_CHANNELS) {
      const characteristic = await service.getCharacteristic(EEG_CHARS[channel]);
      characteristic.addEventListener("characteristicvaluechanged", (event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (value && value.byteLength >= 20) onSamples(channel, decodeMusePacket(value));
      });
      await characteristic.startNotifications();
    }

    await this.send("h"); // halt any existing stream
    await this.send("p21"); // preset 21: 4 EEG channels, 256 Hz
    await this.send("s"); // status
    await this.send("d"); // start data
  }

  /**
   * Headbands slip and Bluetooth drops mid-case. Retry with backoff and keep
   * the case running; only give up — and tell the clinician — after five tries.
   */
  private async attemptReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const attempts = MuseClient.RETRY_DELAYS.length;
    for (let i = 0; i < attempts; i++) {
      if (this.stopping) break;
      this.stateCb?.({ kind: "reconnecting", attempt: i + 1, attempts });
      await new Promise((r) => setTimeout(r, MuseClient.RETRY_DELAYS[i]!));
      if (this.stopping) break;
      try {
        await this.attach();
        this.reconnecting = false;
        this.stateCb?.({ kind: "connected" });
        return;
      } catch {
        /* try again */
      }
    }
    this.reconnecting = false;
    if (!this.stopping) {
      this.stateCb?.({
        kind: "lost",
        reason: "The headband did not come back after five reconnection attempts.",
      });
      this.disconnectCb?.();
    }
  }

  async stop() {
    this.stopping = true;
    try {
      await this.send("h");
    } catch {
      /* device may already be gone */
    }
    this.device?.gatt?.disconnect();
    this.device = null;
    this.control = null;
    this.samplesCb = null;
  }
}

/**
 * Physiologically-shaped simulator used to rehearse the workflow without a
 * headband. Cycles through awake-ish, anaesthetised, burst-suppression and
 * rhythmic ictal-appearing states.
 */
export class SimulatedSource implements EegSource {
  name = "Simulated signal";
  private timer: ReturnType<typeof setInterval> | null = null;
  private t = 0;

  onDisconnect() {
    /* simulator never drops out */
  }

  async start(onSamples: SampleHandler) {
    const fs = 256;
    const chunk = 12;
    this.timer = setInterval(() => {
      for (const channel of MUSE_CHANNELS) {
        const out = new Float64Array(chunk);
        for (let i = 0; i < chunk; i++) {
          // Time is shared across channels: the phase must depend on the
          // sample index, not on how many channels have been rendered.
          out[i] = this.sample(channel, this.t + i / fs);
        }
        onSamples(channel, out);
      }
      this.t += chunk / fs;
    }, (chunk / fs) * 1000);
  }

  private sample(channel: MuseChannel, time: number): number {
    const phase = time;
    const cycle = time % 240;
    const jitter = (Math.random() - 0.5) * 4;
    const gain = channel === "AF7" || channel === "AF8" ? 1.1 : 0.9;

    if (cycle < 60) {
      // Adequate general anaesthesia: strong slow-delta + alpha spindles.
      return (
        gain *
        (28 * Math.sin(2 * Math.PI * 1.4 * phase) +
          16 * Math.sin(2 * Math.PI * 9.5 * phase) +
          jitter)
      );
    }
    if (cycle < 120) {
      // Burst suppression: ~8 s period, 2 s bursts.
      const inBurst = time % 8 < 2;
      return inBurst
        ? gain * (60 * Math.sin(2 * Math.PI * 2.5 * phase) + jitter * 2)
        : jitter * 0.5;
    }
    if (cycle < 180) {
      // Rhythmic 3 Hz ictal-appearing discharges with rising amplitude.
      const ramp = Math.min(1, (cycle - 120) / 20);
      return (
        gain *
        (70 * ramp * Math.sin(2 * Math.PI * 3 * phase) +
          25 * ramp * Math.sin(2 * Math.PI * 6 * phase) +
          jitter)
      );
    }
    // Light sedation: mixed beta and theta.
    return (
      gain *
      (10 * Math.sin(2 * Math.PI * 6 * phase) +
        8 * Math.sin(2 * Math.PI * 18 * phase) +
        jitter * 1.5)
    );
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}