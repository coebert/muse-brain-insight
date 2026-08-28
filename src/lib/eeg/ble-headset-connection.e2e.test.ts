/// <reference types="web-bluetooth" />

import { describe, expect, it, vi } from "vitest";

import { BleHeadsetSource } from "@/lib/eeg/ble-eeg";

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
});