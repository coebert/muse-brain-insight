import { describe, expect, it } from "vitest";
import { planFlush, SPOOL_CHUNK_SECONDS } from "@/lib/eeg/local-raw-spool";

describe("planFlush", () => {
  it("writes nothing until a whole block has arrived", () => {
    expect(planFlush(0, 0, SPOOL_CHUNK_SECONDS - 1)).toEqual([]);
  });

  it("emits contiguous blocks from where it left off", () => {
    const blocks = planFlush(SPOOL_CHUNK_SECONDS, 0, SPOOL_CHUNK_SECONDS * 3.5);
    expect(blocks).toEqual([
      { from: SPOOL_CHUNK_SECONDS, to: SPOOL_CHUNK_SECONDS * 2 },
      { from: SPOOL_CHUNK_SECONDS * 2, to: SPOOL_CHUNK_SECONDS * 3 },
    ]);
  });

  it("skips signal that has already fallen out of the ring", () => {
    const blocks = planFlush(0, 100, 100 + SPOOL_CHUNK_SECONDS);
    expect(blocks).toEqual([{ from: 100, to: 100 + SPOOL_CHUNK_SECONDS }]);
  });

  it("stays on the case clock across a long case", () => {
    const blocks = planFlush(3600, 3600, 3600 + SPOOL_CHUNK_SECONDS * 2);
    expect(blocks[0]?.from).toBe(3600);
    expect(blocks.at(-1)?.to).toBe(3600 + SPOOL_CHUNK_SECONDS * 2);
  });
});
