import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearStagedSave,
  isTransient,
  readStagedSave,
  stageSave,
  STAGED_SAVE_KEY,
  withRetry,
} from "@/lib/eeg/save-staging";

describe("staging a case before it is written", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the payload until the save is confirmed", () => {
    stageSave("CASE-1", { epochs: 12 });
    const staged = readStagedSave<{ epochs: number }>();
    expect(staged?.label).toBe("CASE-1");
    expect(staged?.payload.epochs).toBe(12);
    clearStagedSave();
    expect(readStagedSave()).toBeNull();
  });

  it("ignores a corrupted staging record rather than throwing", () => {
    window.localStorage.setItem(STAGED_SAVE_KEY, "{not json");
    expect(readStagedSave()).toBeNull();
  });
});

describe("withRetry", () => {
  it("returns the first successful result without waiting", async () => {
    const op = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue("saved");
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(op, { sleep })).resolves.toBe("saved");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    const op = vi.fn().mockRejectedValue(new Error("network timeout"));
    await expect(
      withRetry(op, {
        attempts: 3,
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toThrow("network timeout");
    expect(delays).toEqual([100, 200]);
  });

  it("does not retry a permission error", async () => {
    const op = vi.fn().mockRejectedValue(new Error("permission denied for table"));
    await expect(withRetry(op, { shouldRetry: isTransient })).rejects.toThrow(/permission/);
    expect(op).toHaveBeenCalledTimes(1);
  });
});

describe("isTransient", () => {
  it("treats connectivity failures as retryable", () => {
    expect(isTransient(new Error("Failed to fetch"))).toBe(true);
    expect(isTransient(new Error("network error"))).toBe(true);
    expect(isTransient(undefined)).toBe(true);
  });

  it("treats policy and validation failures as permanent", () => {
    expect(isTransient(new Error("new row violates row-level security policy"))).toBe(false);
    expect(isTransient(new Error("duplicate key value"))).toBe(false);
    expect(isTransient(new Error("invalid input syntax for type uuid"))).toBe(false);
  });
});
