import { describe, expect, it, vi } from "vitest";

import { createBackgroundTimer, onForeground } from "@/lib/eeg/keep-awake";

describe("keep-awake", () => {
  it("keeps ticking until it is stopped", async () => {
    const ticks: number[] = [];
    const timer = createBackgroundTimer(10, () => ticks.push(Date.now()));
    await new Promise((r) => setTimeout(r, 60));
    timer.stop();
    const seen = ticks.length;
    expect(seen).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(ticks.length).toBe(seen);
  });

  it("fires when the page returns to the foreground", () => {
    const cb = vi.fn();
    const off = onForeground(cb);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalled();
    off();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
