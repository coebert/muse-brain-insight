import { describe, expect, it } from "vitest";

import {
  cmsnAck,
  cmsnEegMessage,
  cmsnIdentityBytes,
  cmsnOpCommand,
  cmsnOpName,
  cmsnPairCommand,
  CmsnDeframer,
  containsCmsn,
  CMSN_OP,
  CMSN_UV_PER_COUNT,
} from "@/lib/eeg/focuscalm-cmsn";
import { decodePacket, detectPacketFormat } from "@/lib/eeg/ble-eeg";

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));

/**
 * Fixtures captured from the official FocusCalm iOS app streaming from the
 * user's FC-11 headband (Apple PacketLogger HCI trace), so the decoder is
 * locked to bytes the firmware actually sent.
 */
const CAPTURED_EEG_FRAGMENTS = [
  bytes(
    "434d534e00a412a101080110011802229601fdbf40fc5dedfbfb70fc2815fc65aefc7731fc6b44fc6ba5fc65aafc5830fc2c0efbe693fbb5cafbaccafbad94fb8efdfb5393fb2b3dfb2b4dfb33fefb1901fae1c6fac0bbfac7aefad46efabfeffa8f09fa721ffa7df5fa8d8afa7a60fa4b3afa31a6fa4035fa51effa3f63fa12f8f9fd05fa0e8afa22edfa114cf9f553fa19bff9d8f9f98c5cf94f9bf91c52f8efb1f8c8acf8a60b3001504b4544",
  ),
  bytes("434d534e000e08033204100e18004a0408011001504b4544"),
];
const CAPTURED_ACK = bytes("434d534e00080802320410031800504b4544");
const CAPTURED_PAIR_WRITE =
  "434d534e00180801121408023210bcd1770495bd4674a578479480358e28504b4544";

describe("FocusCalm FC-11 CMSN protocol", () => {
  it("reassembles captured frames and decodes 50 EEG samples", () => {
    const deframer = new CmsnDeframer();
    const payloads = CAPTURED_EEG_FRAGMENTS.flatMap((fragment) => deframer.push(fragment));
    expect(payloads).toHaveLength(2);
    const eeg = cmsnEegMessage(payloads[0]!);
    expect(eeg?.samples).toHaveLength(50);
    expect(eeg?.channel).toBe(2);
    // The front end idles at a large negative DC offset and this frame is from
    // the settling period just after the stream starts, so only the order of
    // magnitude is asserted here — the scaling is fixed by the datasheet.
    const microvolts = eeg!.samples.map((count) => count * CMSN_UV_PER_COUNT);
    const range = Math.max(...microvolts) - Math.min(...microvolts);
    expect(range).toBeGreaterThan(1);
    expect(range).toBeLessThan(50_000);
    expect(microvolts.every(Number.isFinite)).toBe(true);
  });


  it("survives fragmentation at arbitrary boundaries", () => {
    const whole = Uint8Array.from(CAPTURED_EEG_FRAGMENTS.flatMap((f) => [...f]));
    const deframer = new CmsnDeframer();
    let samples = 0;
    for (let i = 0; i < whole.length; i += 17) {
      for (const payload of deframer.push(whole.subarray(i, i + 17))) {
        samples += cmsnEegMessage(payload)?.samples.length ?? 0;
      }
    }
    expect(samples).toBe(50);
  });

  it("decodes firmware acknowledgements", () => {
    const payload = new CmsnDeframer().push(CAPTURED_ACK)[0]!;
    const ack = cmsnAck(payload);
    expect(ack).toMatchObject({ messageId: 2, op: CMSN_OP.prepare, result: 0, ok: true });
    expect(cmsnOpName(ack!.op)).toBe("prepare session");
  });

  it("rebuilds the captured pair command byte-for-byte", () => {
    const identity = bytes("bcd1770495bd4674a578479480358e28");
    const frame = cmsnPairCommand(1, identity);
    expect([...frame].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      CAPTURED_PAIR_WRITE,
    );
  });

  it("encodes the start command the app uses", () => {
    expect([...cmsnOpCommand(3, CMSN_OP.startEeg)]).toEqual([
      0x43, 0x4d, 0x53, 0x4e, 0x00, 0x07, 0x08, 0x03, 0x12, 0x03, 0x0a, 0x01, 0x0e, 0x50, 0x4b,
      0x45, 0x44,
    ]);
  });

  it("derives a deterministic 16-byte identity", () => {
    expect(cmsnIdentityBytes("device-a")).toHaveLength(16);
    expect(cmsnIdentityBytes("device-a")).toEqual(cmsnIdentityBytes("device-a"));
    expect(cmsnIdentityBytes("device-a")).not.toEqual(cmsnIdentityBytes("device-b"));
  });

  it("is recognised by the BLE format detector ahead of raw integer readings", () => {
    expect(containsCmsn(CAPTURED_EEG_FRAGMENTS[0]!)).toBe(true);
    const packets = Array.from({ length: 8 }, () => CAPTURED_EEG_FRAGMENTS).flat();
    const detected = detectPacketFormat(packets);
    expect(detected[0]?.format).toBe("focuscalm-cmsn");
    expect(decodePacket("focuscalm-cmsn", CAPTURED_EEG_FRAGMENTS[0]!)).toHaveLength(50);
  });
});
