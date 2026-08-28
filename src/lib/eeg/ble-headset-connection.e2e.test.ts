/// <reference types="web-bluetooth" />

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BleHeadsetSource } from "@/lib/eeg/ble-eeg";

beforeAll(() => {
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: { requestDevice: vi.fn() },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function eegPacket(offset: number): DataView {
  const buffer = new ArrayBuffer(40);
  const view = new DataView(buffer);
  for (let i = 0; i < 20; i++) {
    const t = (offset + i) / 250;
    view.setInt16(i * 2, Math.round(7_000 * Math.sin(2 * Math.PI * 10 * t)), true);
  }
  return view;
}

class MockCharacteristic extends EventTarget {
  uuid = "0000fff1-0000-1000-8000-00805f9b34fb";
  properties = { notify: true, indicate: false } as BluetoothCharacteristicProperties;
  value: DataView | undefined;
  starts = 0;

  async startNotifications() {
    this.starts++;
    if (this.starts === 1) {
      queueMicrotask(() => {
        for (let packet = 0; packet < 50; packet++) this.emit(packet * 20);
      });
    }
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  async stopNotifications() {
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  emit(offset: number) {
    this.value = eegPacket(offset);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class SilentReadableCharacteristic extends EventTarget {
  uuid = "0000fff2-0000-1000-8000-00805f9b34fb";
  properties = { notify: true, indicate: false, read: true } as BluetoothCharacteristicProperties;
  value: DataView | undefined;
  private offset = 0;

  async startNotifications() {
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  async stopNotifications() {
    return this as unknown as BluetoothRemoteGATTCharacteristic;
  }

  async readValue() {
    const value = eegPacket(this.offset);
    this.offset += 20;
    return value;
  }
}

function mockDevice(services: BluetoothRemoteGATTService[]) {
  const server = {
    connected: false,
    async connect() {
      this.connected = true;
      return this;
    },
    disconnect() {
      this.connected = false;
    },
    async getPrimaryServices() {
      return services;
    },
    async getPrimaryService() {
      throw new DOMException("Not found", "NotFoundError");
    },
  };
  const device = new EventTarget() as BluetoothDevice;
  Object.defineProperties(device, {
    name: { value: "Regul8 headband" },
    id: { value: "regul8-test" },
    gatt: { value: server },
  });
  return { device, server };
}

describe("Regul8 connection and ingest", () => {
  it("releases the GATT session after service discovery fails so retry is possible", async () => {
    const { device, server } = mockDevice([]);
    const disconnect = vi.spyOn(server, "disconnect");
    const source = new BleHeadsetSource({ device, listenSeconds: 1 });

    await expect(source.start(() => {})).rejects.toThrow("no readable services");

    expect(disconnect).toHaveBeenCalled();
    expect(server.connected).toBe(false);
  });

  it("connects, discovers the EEG characteristic and delivers mapped samples", async () => {
    const characteristic = new MockCharacteristic();
    const service = {
      uuid: "0000fff0-0000-1000-8000-00805f9b34fb",
      async getCharacteristics() {
        return [characteristic as unknown as BluetoothRemoteGATTCharacteristic];
      },
    } as BluetoothRemoteGATTService;
    const { device, server } = mockDevice([service]);
    const samples: number[] = [];
    const source = new BleHeadsetSource({ device, listenSeconds: 1 });

    await source.start((_channel, chunk) => samples.push(...chunk));
    for (let packet = 50; packet < 75; packet++) characteristic.emit(packet * 20);

    expect(source.discovery?.deviceName).toBe("Regul8 headband");
    expect(source.discovery?.format).toBe("int16le");
    expect(source.discovery?.serviceUuid).toBe(service.uuid);
    expect(server.connected).toBe(true);
    expect(source.health().totalPackets).toBeGreaterThan(0);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every(Number.isFinite)).toBe(true);

    await source.stop();
    expect(server.connected).toBe(false);
  });

  it("waits for Bluefy to report a delayed CoreBluetooth connection", async () => {
    vi.useFakeTimers();
    const characteristic = new MockCharacteristic();
    const service = {
      uuid: "0000fff0-0000-1000-8000-00805f9b34fb",
      async getCharacteristics() {
        return [characteristic as unknown as BluetoothRemoteGATTCharacteristic];
      },
    } as BluetoothRemoteGATTService;
    const { device, server } = mockDevice([service]);
    server.connect = vi.fn(async function (this: typeof server) {
      setTimeout(() => {
        this.connected = true;
      }, 300);
      return this;
    });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Bluefy iPhone" });
    const source = new BleHeadsetSource({ device, listenSeconds: 1 });

    const starting = source.start(() => {});
    await vi.advanceTimersByTimeAsync(1_500);
    await starting;

    expect(server.connect).toHaveBeenCalledTimes(1);
    expect(server.connected).toBe(true);
    await source.stop();
  });

  it("falls back to reading a stream buffer when notifications are silent", async () => {
    const characteristic = new SilentReadableCharacteristic();
    const service = {
      uuid: "0000fff0-0000-1000-8000-00805f9b34fb",
      async getCharacteristics() {
        return [characteristic as unknown as BluetoothRemoteGATTCharacteristic];
      },
    } as BluetoothRemoteGATTService;
    const { device } = mockDevice([service]);
    const samples: number[] = [];
    const source = new BleHeadsetSource({ device, listenSeconds: 1 });

    await source.start((_channel, chunk) => samples.push(...chunk));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(source.discovery?.characteristicUuid).toBe(characteristic.uuid);
    expect(source.discovery?.format).toBe("int16le");
    expect(samples.length).toBeGreaterThan(0);
    await source.stop();
  });

  it("reports notification setup failures instead of claiming the band sent no data", async () => {
    const characteristic = new MockCharacteristic();
    characteristic.startNotifications = vi.fn(async () => {
      throw new DOMException("Notifications are unavailable", "NotSupportedError");
    });
    const service = {
      uuid: "0000fff0-0000-1000-8000-00805f9b34fb",
      async getCharacteristics() {
        return [characteristic as unknown as BluetoothRemoteGATTCharacteristic];
      },
    } as BluetoothRemoteGATTService;
    const { device } = mockDevice([service]);
    const source = new BleHeadsetSource({ device, listenSeconds: 1 });

    await expect(source.start(() => {})).rejects.toThrow("notification subscription failed");
  });
});