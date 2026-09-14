import { describe, expect, it } from "vitest";

import { RAW_ARCHIVE_HZ, createRawArchive } from "./raw-archive";

const chunk = (n: number, value = 1) => new Float32Array(n).fill(value);

describe("raw archive", () => {
  it("keeps the case clock across a dropout instead of closing the gap", () => {
    const archive = createRawArchive();
    const hz = RAW_ARCHIVE_HZ;
    let t = 1_000_000;

    // Ten seconds of signal, one second per push.
    for (let i = 0; i < 10; i++) {
      t += 1000;
      archive.push("AF7", chunk(hz), hz, t);
    }
    expect(archive.duration("AF7")).toBeCloseTo(10, 1);

    // The headband is away for thirty seconds, then returns.
    t += 31_000;
    archive.push("AF7", chunk(hz), hz, t);

    // The archive is 41 s long, not 11 s: the outage is still there as silence.
    expect(archive.duration("AF7")).toBeCloseTo(41, 0);
    const gap = archive.read("AF7", 20, 25);
    expect(gap.every((v) => v === 0)).toBe(true);
    // …and signal resumes at its real place on the clock.
    const after = archive.read("AF7", 40, 41);
    expect(after.some((v) => v !== 0)).toBe(true);
  });

  it("does not pad for jitter inside the tolerance", () => {
    const archive = createRawArchive();
    const hz = RAW_ARCHIVE_HZ;
    let t = 1_000_000;
    for (let i = 0; i < 5; i++) {
      t += 1050; // slightly slow, drift stays under half a second
      archive.push("AF7", chunk(hz), hz, t);
    }
    expect(archive.duration("AF7")).toBeCloseTo(5, 2);
  });
});
