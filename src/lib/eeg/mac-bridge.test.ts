import { describe, expect, it, vi } from "vitest";

import {
  MacBridgeSource,
  bridgeIngestConfig,
  parseBridgeHello,
  parseBridgeSamples,
} from "@/lib/eeg/mac-bridge";

/** Minimal WebSocket stand-in the source can drive in tests. */
class FakeSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  open() {
    this.onopen?.();
  }

  emit(object: unknown) {
    this.onmessage?.({ data: JSON.stringify(object) } as MessageEvent);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }
}

const HELLO = {
  type: "hello",
  device: "Regul8 Headband",
  firmware: "1.1.6",
  channels: ["AF7"],
  sampleRate: 250,
  unit: "uV",
};

async function startSource(socket: FakeSocket, extra: Record<string, unknown> = {}) {
  const samples: { channel: string; count: number }[] = [];
  const source = new MacBridgeSource({
    url: "ws://127.0.0.1:8787",
    socketFactory: () => socket as unknown as WebSocket,
    ...extra,
  });
  const started = source.start((channel, values) =>
    samples.push({ channel, count: values.length }),
  );
  socket.open();
  await started;
  return { source, samples };
}

describe("bridge frame parsing", () => {
  it("accepts a well-formed hello and rejects malformed ones", () => {
    expect(parseBridgeHello(HELLO)?.sampleRate).toBe(250);
    expect(parseBridgeHello({ ...HELLO, channels: ["NOPE"] })).toBeNull();
    expect(parseBridgeHello({ ...HELLO, sampleRate: 0 })).toBeNull();
    expect(parseBridgeHello({ type: "samples" })).toBeNull();
  });

  it("maps declared channels onto their own analysis electrodes in microvolts", () => {
    const config = bridgeIngestConfig(parseBridgeHello(HELLO)!);
    expect(config.unit).toBe("uV");
    expect(config.channelMap).toEqual({ TP9: null, AF7: "AF7", AF8: null, TP10: null });
  });

  it("replaces non-finite samples with zero rather than dropping the frame", () => {
    const frame = parseBridgeSamples({
      type: "samples",
      channels: { AF7: [1, Number.NaN, 3, "x"] },
    });
    expect(frame?.["AF7"]).toEqual([1, 0, 3, 0]);
  });
});

describe("MacBridgeSource", () => {
  it("streams resampled microvolts to the analysis pipeline once hello arrives", async () => {
    const socket = new FakeSocket();
    const { source, samples } = await startSource(socket);

    // Samples before hello cannot be mapped onto a montage.
    socket.emit({ type: "samples", channels: { AF7: [1, 2, 3] } });
    expect(samples).toHaveLength(0);

    socket.emit(HELLO);
    socket.emit({ type: "samples", channels: { AF7: Array.from({ length: 250 }, () => 10) } });

    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.channel === "AF7")).toBe(true);
    // 250 Hz in, 256 Hz analysis rate out.
    const total = samples.reduce((sum, s) => sum + s.count, 0);
    expect(total).toBeGreaterThanOrEqual(245);
    expect(total).toBeLessThanOrEqual(262);
    expect(source.describe()?.firmware).toBe("1.1.6");
    await source.stop();
  });

  it("reports battery and bridge status changes", async () => {
    const socket = new FakeSocket();
    const { source } = await startSource(socket);
    const states: string[] = [];
    const battery: number[] = [];
    source.onState((state) => states.push(state.kind));
    source.onBattery((percent) => battery.push(percent));

    socket.emit({ type: "battery", percent: 88 });
    socket.emit({ type: "status", state: "reconnecting", reason: "quiet" });
    socket.emit({ type: "status", state: "connected" });

    expect(battery).toEqual([88]);
    expect(states).toEqual(["reconnecting", "connected"]);
    await source.stop();
  });

  it("flags a connected-but-silent bridge instead of looking healthy", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const socket = new FakeSocket();
      const { source } = await startSource(socket, { now: () => now });
      const states: string[] = [];
      source.onState((state) => states.push(state.kind));

      socket.emit(HELLO);
      now = 20_000;
      vi.advanceTimersByTime(4_000);

      expect(states).toContain("lost");
      await source.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces bridge log lines so handshake acks are visible in the app", async () => {
    const socket = new FakeSocket();
    const logs: string[] = [];
    const { source } = await startSource(socket, {
      onLog: (line: { message: string }) => logs.push(line.message),
    });
    socket.emit({ type: "log", level: "info", message: "ack op 14 result 0" });
    expect(logs).toEqual(["ack op 14 result 0"]);
    await source.stop();
  });
});
